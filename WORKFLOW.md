# Meridian — Workflow & Capabilities

Autonomous DLMM Liquidity-Provider agent for Meteora (Solana). Self-driving, self-evolving, and self-updating.

---

## 1. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        MERIDIAN (index.js)                         │
│                                                                    │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────┐   │
│  │ Telegram │   │  REPL    │   │  Cron    │   │  Hindsight   │   │
│  │   Bot    │◄──► Loop     │◄──► Cycles   │◄──►  Bootstrap  │   │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └──────┬───────┘   │
│       │              │              │                │            │
└───────┼──────────────┼──────────────┼────────────────┼────────────┘
        │              │              │                │
        ▼              ▼              ▼                ▼
   ┌────────┐    ┌──────────┐   ┌──────────┐    ┌───────────┐
   │  User  │    │  Agent   │   │  Agent   │    │  Memory   │
   │  Chat  │    │ MANAGER  │   │ SCREENER │    │   Layer   │
   │        │    │  (ReAct) │   │  (ReAct) │    │ (Docker)  │
   └────────┘    └────┬─────┘   └────┬─────┘    └───────────┘
                      │              │
                      ▼              ▼
              ┌─────────────────────────────┐
              │     Tool Executor (LLM)     │
              │  • DLMM SDK   • Sentinel    │
              │  • Wallet     • Screening   │
              │  • Hindsight  • Study       │
              │  • Token      • State       │
              └──────────┬──────────────────┘
                         │
                         ▼
                 ┌──────────────────┐
                 │  Meteora / Solana│
                 │  (via RPC + Jup) │
                 └──────────────────┘
```

---

## 2. Startup Sequence

When `node index.js` runs:

1. **Load env + config** — `envcrypt.js` decrypts `.env` → `config.js` merges `.env` with `user-config.json` (runtime mutations from `update_config` are persisted here).
2. **Generate agent ID** — `ensureAgentId()` creates a unique ID stored in `hivemind-id.json` so this instance is identifiable on the collective.
3. **Bootstrap HiveMind** (fire-and-forget) — registers with the collective intelligence server, pulls shared lessons/presets.
4. **Bootstrap Hindsight** (fire-and-forget) — if `hindsightEnabled=true` and the URL is localhost, runs `docker compose up -d` and waits for `http://localhost:8888/health` to return 200. Cached health probe (60s TTL) prevents log spam.
5. **Start cron jobs** — management cycle (default every 10 min), screening cycle (default every 30 min), health check (hourly), morning briefing (01:00 UTC), PnL poll (continuous).
6. **Start Telegram polling** — long-poll loop with a queue to serialize messages (only one agent loop at a time).
7. **Print REPL prompt** — if TTY, opens a CLI; otherwise just runs headless.

---

## 3. Cron Cycles

### 3.1 Management Cycle (default: every 10 min)

```
runManagementCycle()
  │
  ├─► Get wallet SOL balance
  ├─► Get all open positions (force: true — fresh count)
  │
  ├─► For each position, fetch:
  │   • PnL (fees_earned_usd, pnl_pct, pnl_usd, current_value)
  │   • Out-of-range duration
  │   • Active bin drift
  │   • Sentinel pre-evaluation (regime, P_exit, IL)
  │
  ├─► Check trailing-peak / trailing-drop / TP rules
  │   → schedulePeakConfirmation() (5 min cooldown)
  │   → scheduleTrailingDropConfirmation()
  │
  ├─► If any position needs action:
  │   → invoke LLM [model: managementModel] as MANAGER role
  │     Available tools: close_position, claim_fees, swap_token,
  │     sentinel_analyze, sentinel_evaluate_closed, sentinel_get_status,
  │     memory ops, etc.
  │
  └─► If all positions STAY → skip LLM call (saves tokens)
       After action, if position count dropped < max → trigger screening
```

### 3.2 Screening Cycle (default: every 30 min)

```
runScreeningCycle()
  │
  ├─► PRE-CHECKS (in order, each can short-circuit):
  │   1. _screeningLastTriggered gate (no concurrent runs)
  │   2. maxPositions check (force-fresh, not cache)
  │   3. SOL balance check (must cover deployAmountSol + gasReserve)
  │   4. blockedLaunchpads check (enforced inside getTopCandidates)
  │
  ├─► getTopCandidates() → Meteora pool-discovery API
  │   Filters: minFeeActiveTvlRatio, minTvl/maxTvl, minVolume, minOrganic,
  │            minHolders, minMcap/maxMcap, minBinStep/maxBinStep,
  │            minTokenFeesSol, maxBundlersPct, maxTop10Pct
  │   Returns: ranked list of pools with volatility, organic score,
  │            holder distribution, bin_step, fee tier
  │
  ├─► For top N candidates, optionally enrich with:
  │   • get_token_info (Jupiter)
  │   • get_token_holders (bundler detection)
  │   • check_smart_wallets_on_pool (KOL/alpha presence)
  │   • get_token_narrative
  │
  ├─► Invoke LLM [model: screeningModel] as SCREENER role
  │   Available tools: deploy_position, get_active_bin, get_top_candidates,
  │   check_smart_wallets_on_pool, get_token_holders, get_token_narrative,
  │   get_token_info, search_pools, get_pool_memory, recall/reflect/retain_memory
  │
  └─► LLM picks 0 or 1 pool to deploy
       → executor safety checks (see §6)
       → deployPosition (single-side SOL)
       → trackPosition (state.js)
       → Telegram notification
```

### 3.3 Continuous PnL Poll

`setInterval` (60s) checks each open position. If a position's `pnl_pct` suddenly jumps > TP% from a recent peak, or drops sharply, it schedules a peak/trailing-drop confirmation with a 5-min cooldown. The full management cycle runs as a backstop, but the poll catches fast moves in between cycles.

---

## 4. Agent Roles (ReAct Loop)

`agentLoop()` in `agent.js` runs a Reason-Act loop with the LLM (OpenRouter / OpenAI-compatible / LM Studio):

```
SYSTEM PROMPT  (built by prompt.js per role)
   │
   ▼
USER GOAL
   │
   ▼
LLM  ─── thinks ──► emits tool_call
   │                       │
   │                       ▼
   │              executeTool(name, args)
   │                       │
   │                       ▼
   │              safety checks → result
   │                       │
   │                       ▼
   ◄───────────────── tool result
   │
   ▼
LLM  ─── thinks ──► emits tool_call (next)
   │                       │
   ▼                       ▼
...                        ...
   │
   ▼
LLM  ─── no tool_call ──► text response
   │
   ▼
return response to caller
```

### Role → Tool Set

| Role | Triggered by | Tools |
|------|--------------|-------|
| **SCREENER** | screening cron / intent `deploy` | `deploy_position`, `get_active_bin`, `get_top_candidates`, `check_smart_wallets_on_pool`, `get_token_holders`, `get_token_narrative`, `get_token_info`, `search_pools`, `get_pool_memory`, `get_wallet_balance`, `get_my_positions`, memory ops |
| **MANAGER** | management cron / intent `close` or `claim` | `close_position`, `claim_fees`, `swap_token`, `get_position_pnl`, `get_my_positions`, `get_wallet_balance`, all `sentinel_*` tools, memory ops |
| **GENERAL** | REPL / Telegram chat | Subset selected by intent-pattern matching (deploy, close, claim, swap, sentinel, config, blocklist, balance, positions, strategy, screen, memory, smartwallet, study, performance, lessons, etc.). Tools not in any intent set are general-purpose: `self_update`, `update_config`, lesson/strategy management. |

---

## 5. Tool Inventory (32+ tools)

### DLMM Core
- `deploy_position` — open a new LP position (single-side SOL, calculated bins_below from volatility)
- `close_position` — close a position, auto-swap dust back to SOL
- `claim_fees` — claim accumulated fees without closing
- `get_my_positions` — list open positions with PnL
- `get_position_pnl` — detailed PnL breakdown for one position
- `get_active_bin` — read pool active bin + price
- `get_wallet_positions` — list ALL positions owned by wallet (general role only)
- `search_pools` — Meteora API search

### Screening & Discovery
- `get_top_candidates` — pool discovery with all configured filters
- `discover_pools` — raw pool discovery
- `get_pool_detail` — single pool full detail
- `check_smart_wallets_on_pool` — KOL/alpha wallet presence
- `get_token_info` / `get_token_narrative` / `get_token_holders` — Jupiter data + bundler detection

### Wallet & Swap
- `get_wallet_balance` — SOL + token balances
- `swap_token` — Jupiter swap (used post-close for dust)

### Study / Research
- `study_top_lpers` — top LPer behavior via LPAgent API
- `get_top_lpers` — list top LPers

### Sentinel (IL Mitigation) — 9 tools
- `sentinel_analyze` — full 4-module evaluation
- `sentinel_calculate_reward` — R_t = α·F − β·ΔIL − γ·C − λ·P
- `sentinel_classify_regime` — regime classifier
- `sentinel_calculate_p_exit` — normal-CDF bin-exit probability
- `sentinel_calculate_il` — AMM IL
- `sentinel_get_status` — current weights/thresholds + reward history
- `sentinel_set_weights` — runtime α/β/γ/λ tuning
- `sentinel_set_thresholds` — runtime regime/IL/P_exit cutoffs
- `sentinel_evaluate_closed` — post-mortem reward capture

### State & Strategy
- `add_pool_note` / `set_position_note` — operator annotations
- `add_lesson` / `pin_lesson` / `unpin_lesson` / `clear_lessons` / `list_lessons` — knowledge
- `add_strategy` / `remove_strategy` / `set_active_strategy` / `list_strategies` / `get_strategy` — LP playbook

### Risk & Config
- `add_to_blacklist` / `remove_from_blacklist` / `list_blacklist` — token blacklist
- `block_deployer` / `unblock_deployer` / `list_blocked_deployers` — dev blocklist
- `add_smart_wallet` / `remove_smart_wallet` / `list_smart_wallets` — KOL watchlist
- `update_config` — runtime config mutations (persisted + cron restart if intervals changed)
- `self_update` — `git pull` + restart (Telegram `selfupdate` intent)

### Memory
- `recall_memory` / `reflect_on_memory` / `retain_memory` — Hindsight banks
- `get_pool_memory` — per-pool history from `pool-memory.json`

### Diagnostics
- `get_recent_decisions` — last N decisions from `decision-log.json`
- `get_performance_history` — closed-position ledger

---

## 6. Screener Safety Checks (executor.js)

Before `deploy_position` actually broadcasts:

| Check | Rule | Reason |
|-------|------|--------|
| `bin_step` | must be in `[minBinStep, maxBinStep]` (default 80–125) | DLMM fee curve fit |
| `volatility` | positive finite number | Refuses 0/null from fresh pool detail |
| Range size | total bins ≥ `max(35, minBinsBelow)` | Prevents 1-bin/tiny deploys |
| Position count | `< maxPositions` (force-fresh) | Race-condition guard |
| Duplicate pool | no same `pool_address` already open | No double exposure |
| Duplicate base | no same `base_mint` in another pool | Concentrated risk |
| `amount_x` | must be 0 (no token side) | Single-side SOL only |
| SOL balance | must cover `amount_y + gasReserve` | Prevents failed tx |
| `blockedLaunchpads` | filtered before LLM sees | Avoid scam launchpads |
| Duplicate base mint | one pool per base | Risk concentration |

After a successful deploy:
- `trackPosition()` in `state.js` (with bin range, OOR timestamp, snapshot)
- Telegram notification with deployed amount, range, regime (from Sentinel), expected P_exit
- `recordPoolDeploy()` in `pool-memory.js` → Hindsight bank

---

## 7. DLMM Sentinel — 4-Module IL Mitigation

A meta-skill for active IL management. Wired into the manager role and auto-fires on close.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   ┌──────────┐  ┌──────────────┐  ┌──────────────┐      │
│   │ SENSING  │→ │ ANTICIPATION │→ │ MITIGATION   │      │
│   │          │  │              │  │              │      │
│   │ • active │  │ • regime     │  │ • shape      │      │
│   │   bin    │  │   classifier │  │   rebalance  │      │
│   │ • PnL    │  │ • P_exit     │  │ • tighten    │      │
│   │ • on-    │  │   (normal    │  │ • asymmetric │      │
│   │   chain  │  │   CDF)       │  │   ladder     │      │
│   │   state  │  │ • vol       │  │ • hedge      │      │
│   │          │  │   trend      │  │ • emergency  │      │
│   └──────────┘  │ • mean       │  │   withdraw   │      │
│        │        │   reversion  │  │ • hold       │      │
│        │        └──────────────┘  └──────┬───────┘      │
│        │                                 │              │
│        └────────────►┌──────────┐◄────────┘              │
│                     │ LEARNING  │                        │
│                     │           │                        │
│                     │ R_t = αF  │                        │
│                     │   − βΔIL  │                        │
│                     │   − γC    │                        │
│                     │   − λP    │                        │
│                     └─────┬─────┘                        │
│                           │                              │
│                           ▼                              │
│                  ┌──────────────────┐                    │
│                  │ sentinel-state   │                    │
│                  │ + Hindsight bank │                    │
│                  └──────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

### Regime → Action Mapping

| Regime | Detected When | Recommended Shape | Rationale |
|--------|---------------|-------------------|-----------|
| `LOW_VOL_SIDEWAYS` | vol < 3.5, |trend| < 0.4 | `bid_ask` (tighten factor 0.7) | Concentrate to harvest dynamic fees |
| `HIGH_VOL_TRENDING` | vol ≥ 3.5 & |trend| ≥ 0.4 | `curve` (widen factor 1.5) | Spread horizontally, slow IL |
| `MEAN_REVERTING` | mean-reversion ≥ 0.6 | `spot` (asymmetric ratio 0.7) | Laddered TP / buy-the-dip |
| `EMERGENCY` (override) | `|IL| ≥ 15%` | `withdraw` | Full exit, skips cooldown |

### Reward Signal

$$R_t = \alpha \cdot F_t - \beta \cdot \Delta\text{IL}_t - \gamma \cdot C_t - \lambda \cdot P_t$$

| Component | Default | Meaning |
|-----------|---------|---------|
| α (alpha) | 1.0 | Fee reward weight |
| β (beta)  | 2.0 | **IL penalty (highest weight)** |
| γ (gamma) | 0.5 | Gas/transaction cost |
| λ (lambda)| 1.0 | Out-of-range penalty |

Recorded on every close via `lessons.js → recordPerformance → evaluateClosedPosition()`. Auto-retained to Hindsight `pools` bank as `sentinel_evaluation` facts.

### Sentinel Thresholds

- **Rebalance cooldown**: 300s per position (prevents noise-trading)
- **Hedge trigger**: `|IL| ≥ 2%` → `HEDGE_DELTA` (perp-short suggestion, size 50%)
- **Emergency trigger**: `|IL| ≥ 15%` → `EMERGENCY_WITHDRAW` (bypasses cooldown)
- **P_exit bands**: `< 15%` → tighten, `> 60%` → widen

---

## 8. Hindsight Memory Layer (Optional)

Biomimetic memory service running in Docker (port 8888). Adds structured retain/recall/reflect on top of local JSON files.

### Banks (default prefix `meridian`)

| Bank | Purpose | Auto-wired From |
|------|---------|-----------------|
| `meridian_lessons` | Closed-position rules | `lessons.js → recordPerformance()` |
| `meridian_pools` | Per-pool facts, deploy history, snapshots, cooldowns, operator notes, Sentinel evals | `pool-memory.js`, `sentinel.js` |
| `meridian_strategies` | LP strategy library | `strategy-library.js → addStrategy()` |
| `meridian_reflections` | Auto-derived mental models | every 5 closes, `hindsightReflect()` runs |

### Recall Strategy

- 4 parallel: semantic vectors, BM25 keywords, graph (entity/temporal/causal), time range
- Fused via RRF + cross-encoder rerank
- When `hindsightAutoRecall=true`, top-K results auto-injected into the system prompt as **"RELEVANT PAST EXPERIENCE"** section

### Fail-Safe

If Hindsight is disabled, unreachable, or the npm client is missing, every call returns `null`/`[]` — Meridian keeps working with local JSON. No code path depends on Hindsight being up.

---

## 9. HiveMind (Collective Intelligence)

- `ensureAgentId()` — stable per-instance ID
- `bootstrapHiveMind()` — registers with the collective server at startup
- `startHiveMindBackgroundSync()` — periodic lesson/preset pull from peers
- `pushHiveLesson(lesson)` / `pushHivePerformanceEvent(event)` — share wins/losses with the network
- `pullHiveMindLessons()` / `pullHiveMindPresets()` — adopt peer lessons into local `lessons.json` / `strategy-library.json`
- Shared lessons injected into manager prompt so the agent learns from all deployed agents in the collective

---

## 10. Telegram Interface

### Direct Commands (bypass LLM)

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar `[████████░░░░░░░░░░░░] 40%` |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |
| `/pause` | Stop cron cycles |
| `/resume` | Restart cron cycles |
| `/pull` | `self_update` (git pull + restart) |
| `/briefing` | Manual morning briefing |
| `/strategy` / `/strategies` | List LP strategies |
| `/status` | Current config + positions + wallet |

### LLM-Driven (any free-form message)

Sent through `agentLoop()` with GENERAL role. Intent-pattern matching picks the tool subset (deploy, close, claim, swap, sentinel, config, blocklist, balance, positions, strategy, screen, memory, smartwallet, study, performance, lessons, etc.).

### Notifications

- Deploy success: pair, amount, range, regime, expected P_exit
- Close success: PnL%, fees, reason
- Out-of-range: alert + 30-min wait window
- Peak/trailing-drop detection: confirmation prompt with buttons
- Morning briefing (HTML, 01:00 UTC): PnL, top movers, lessons learned
- Sentinel emergency: high-priority alert

---

## 11. Self-Update Mechanism

- `self_update` tool → `git pull --rebase` → if `package.json` changed → `npm install` → restart process
- Triggered by Telegram `/pull` or `selfupdate` intent
- Coordinator PM2-compatible: re-spawns the process and keeps REPL/cron alive

---

## 12. Lifecycle of a Position

```
1. SCREENER discovers pool
   → getTopCandidates() → filtered list
   → LLM picks best candidate
   → safety checks
   → deployPosition (single-side SOL, bins_below from volatility)
   → trackPosition() in state.js
   → Telegram notify
   → recordPoolDeploy() + Hindsight retain

2. MONITOR
   • management cron: re-evaluate PnL, OOR, peak/trailing
   • PnL poll: fast-move detection
   • Sentinel pre-eval: regime + P_exit
   • pool-memory snapshots every cycle

3. DECISION (LLM)
   • If position healthy + in-range → HOLD (skip LLM)
   • If peak confirmed → partial close (TP rule)
   • If OOR > outOfRangeWaitMinutes → close
   • If Sentinel recommends → rebalance/hedge/withdraw
   • If user instruction set → follow instruction

4. CLOSE
   • closePosition on-chain
   • recordPerformance() in lessons.js
   • evaluateClosedPosition() → Sentinel reward
   • auto-swap base token → SOL (skip if dust < $0.10)
   • Telegram notify with PnL breakdown
   • Every 5 closes → hindsightReflect() deep analysis

5. LEARN
   • Lesson retained to local + Hindsight
   • evolveThresholds() updates screening config (auto-tuned from winners vs losers)
   • Strategy library updated with new meta-strategies
   • HiveMind broadcasts the lesson
```

---

## 13. State Persistence

All state lives in local JSON files (auto-rotated/cleaned by the agent):

| File | Purpose |
|------|---------|
| `state.json` | Open positions: bin ranges, OOR timestamps, instructions, peak/trailing drop tracking |
| `pool-memory.json` | Per-pool deploy history, snapshots, cooldowns, operator notes |
| `lessons.json` | Closed-position lessons, pinned rules, performance ledger |
| `strategy-library.json` | Saved LP strategies (defaults + custom) |
| `smart-wallets.json` | Tracked KOL/alpha wallets |
| `token-blacklist.json` | Permanent token blacklist |
| `dev-blocklist.json` | Blocked deployers/launchpads |
| `sentinel-state.json` | Sentinel evaluations + reward history (gitignored) |
| `decision-log.json` | Last N decisions (why-deployed / why-closed) |
| `hivemind-id.json` | Stable per-instance agent ID |
| `user-config.json` | Runtime config (mutated by `update_config`) |
| `logs/YYYY-MM-DD.log` | Daily-rotating log |
| `action-audit.jsonl` | Append-only audit trail of all on-chain actions |

---

## 14. Risk Management (Hard Limits)

| Limit | Default | Where |
|-------|---------|-------|
| Max concurrent positions | 3 | `config.risk.maxPositions` |
| Max deploy amount per position | 50 SOL | `config.risk.maxDeployAmount` |
| Gas reserve | 0.2 SOL | `config.management.gasReserve` |
| Min SOL to open new position | 0.55 SOL | `config.management.minSolToOpen` |
| Position size (% of wallet) | 35% | `config.management.positionSizePct` |
| Out-of-range wait | 30 min | `config.management.outOfRangeWaitMinutes` |
| Sentinel rebalance cooldown | 300s | `config.sentinel.control.rebalanceCooldownSec` |
| Sentinel emergency IL | 15% | `config.sentinel.thresholds.ilPctEmergency` |
| Single-side deploy only | (enforced) | `executor.js` (rejects `amount_x > 0`) |

DRY_RUN mode: all on-chain transactions are simulated — agent loops, learns, and rebalances logically without broadcasting.

---

## 15. Model & Provider Support

- **Default**: `openrouter/healer-alpha`
- **Fallback on 502/503/529**: `stepfun/step-3.5-flash:free` (2nd attempt) then retry
- **Per-role models** in `user-config.json`:
  - `managementModel` — running open positions
  - `screeningModel` — finding new opportunities
  - `generalModel` — REPL/Telegram chat
- **Local LLM (LM Studio)**: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- **Min `maxOutputTokens`**: 2048 (free models may have lower limits causing empty responses)

---

## 16. End-to-End Flow Example

```
09:00:00  cron fires runScreeningCycle()
09:00:01  getTopCandidates() → 8 pools
09:00:02  LLM (SCREENER) thinks: "Pool #3 has best fee/TVL + smart wallet presence + low bundlers"
09:00:04  LLM tool_call: deploy_position(pool=ABC, amount=0.5 SOL, bins_below=42)
09:00:05  safety checks pass
09:00:06  on-chain deploy → position address 7xK...
09:00:07  trackPosition + Telegram notify
09:00:08  recordPoolDeploy → Hindsight retain

... 10 minutes pass, no action needed ...

09:10:00  cron fires runManagementCycle()
09:10:01  PnL poll: position in-range, +0.5% on 0.02 SOL fees
09:10:02  Sentinel pre-eval: regime=LOW_VOL_SIDEWAYS, P_exit=0.08
09:10:03  Decision: HOLD → skip LLM call

... 2 hours pass, vol spikes ...

11:10:00  cron fires runManagementCycle()
11:10:01  Sentinel pre-eval: regime=HIGH_VOL_TRENDING, P_exit=0.45
11:10:02  Decision: needs rebalance → invoke LLM (MANAGER)
11:10:04  LLM tool_call: sentinel_analyze(...) → recommends REBALANCE_SHAPE (curve, factor 1.5)
11:10:05  LLM tool_call: deploy_position with new range (close old, open new with curve shape)
11:10:06  on-chain rebalance
11:10:08  recordEvaluation → R_t = +18.4 → Hindsight retain

... price keeps trending down, IL builds up ...

14:30:00  PnL poll detects sharp drop
14:30:01  scheduleTrailingDropConfirmation() (5 min cooldown)
14:35:00  Trailing-drop confirmed → invoke LLM
14:35:02  LLM tool_call: sentinel_analyze → |IL|=12% → HEDGE_DELTA
14:35:03  LLM decides to close (no perp venue reachable) → tool_call: close_position
14:35:04  on-chain close → base token → SOL swap (Jupiter)
14:35:06  recordPerformance() → fees=0.08, gas=0.001, pnl=-0.12
14:35:07  evaluateClosedPosition() → R_t = (1·0.08) - (2·0.12) - (0.5·0.001) - (1·0) = -0.16
14:35:08  Telegram notify: "Position closed. Net PnL: -0.04 SOL (-8%). Lesson recorded."
14:35:09  Lesson: "Pool ABC's HIGH_VOL_TRENDING regime can flip to EMERGENCY in <2h. Reduce max bins_below for similar profiles."

... next cycle ...

14:40:00  cron fires runScreeningCycle()
14:40:01  Hindsight auto-recall: surfaces the new lesson into system prompt
14:40:02  LLM (SCREENER) sees the lesson → avoids similar profile unless bins_below is reduced
```

---

## 17. Summary — What Makes Meridian Self-Driving

1. **Self-screening** — finds pools matching evolved criteria from Meteora API
2. **Self-deploying** — opens positions with risk-checked single-side SOL, learns optimal bins_below from volatility
3. **Self-monitoring** — PnL poll + cron + Sentinel pre-eval
4. **Self-rebalancing** — LLM-invoked Sentinel recommends shape shifts on regime change
5. **Self-hedging** — perp-short suggestion when |IL| ≥ 2%
6. **Self-emergency** — full withdraw at |IL| ≥ 15%
7. **Self-learning** — lessons from every close, auto-evolved thresholds, Hindsight recall injection
8. **Self-reflecting** — periodic deep analysis every 5 closes
9. **Self-updating** — `git pull` + restart via Telegram `/pull`
10. **Self-organizing** — HiveMind shares wins/losses with the collective, pulls peer lessons
11. **Self-reporting** — Telegram notifications, daily HTML briefing, decision log
12. **Self-suspending** — DRY_RUN mode, /pause, runtime config mutation
