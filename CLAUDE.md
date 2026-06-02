# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hivemind.js         Agent Meridian HiveMind sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

## SCREENER Performance Layer

The screener was rebuilt for higher-quality deploy decisions. All improvements are backward-compatible and gated behind new config keys (default = current behavior, more determinism + memory + pre-fetch on top).

### Prompt Architecture (`prompt.js` SCREENER section)

The system prompt now opens with **lessons + Hindsight recall at the top** (highest priority), then Darwinian signal weights, then the structured reasoning template. The reasoning template forces the LLM to walk through each candidate against a 6-point checklist (hard rules → risk signals → narrative quality → pool memory → smart wallets → conviction score 1-10) before deciding. The deploy decision must be followed by a `MANDATORY PRE-DEPLOY SELF-CHECK` (5 unchecked boxes that must all be ☐✓) and a final `CONVICTION: <1-10>` line.

`extractConvictionScore()` in `agent.js` parses the score from the LLM response and logs it to `decision-log.json`. Low-conviction deploys (`< minConvictionScore`, default 7) are flagged via `screening_warn` log for post-mortem analytics — the lessons system can later correlate conviction → PnL.

### Per-Role Decoding (`config.llm.{screening, management, general}`)

| Role | Temperature | Top-p | Rationale |
|------|-------------|-------|-----------|
| `screening` | 0.15 (was 0.373) | 0.9 | Rule application + ranking. Low temp = more deterministic deploy/skip decisions. |
| `management` | 0.25 (was 0.373) | 0.9 | Position management + trade-off reasoning. Slightly more deterministic than default. |
| `general` | 0.373 (unchanged) | 0.9 | Chat + interactive. |

Override per role via `screeningTemperature`, `screeningTopP`, etc. in `user-config.json`.

### Pre-Fetch Enrichment (`tools/screening.js`, `index.js`)

`compositeScore(pool, { smartWalletCount, poolMemorySignals })` returns a 0-100 pre-computed conviction score for each candidate. Formula:

```
+ min(40, fee_tvl × 80)        // dominant signal
+ min(20, organic / 5)
+ min(15, smart_wallets × 7.5) // capped at 2 wallets
+ min(10, log10(volume) × 2.5)
+ min(5, log10(holders) × 2)
+ 5 if mcap in [200k, 2M]
+ 5 if volatility in [1, 4]
− 10 if top10 > 60%
− 10 if bundle_pct > 30%
− 50 if is_rugpull
− 50 if is_wash
− 15 if is_pvp
− 5 if dex_boost/dex_screener_paid
− 20 if pool_memory.hasLoss
− 10 if pool_memory.avgPnl < 0
− 30 if pool_memory.cooldownActive
```

Candidates are now pre-sorted by composite score in `getTopCandidates()` so the LLM only sees the strongest setups first. The candidate block in the LLM goal also includes:
- `composite_score: N/100` (pre-computed, used as tiebreaker)
- `memory_flag: ⚠️ COOLDOWN ACTIVE | ⚠️ PAST LOSS | 🚨 HIGH-RISK POOL` (inline warning)

### Targeted Hindsight Recall (`agent.js`)

Per-role recall query shaping:
- **SCREENER**: `screening precedent outcomes: tokens with similar mcap volatility organic_score smart_wallets deploy win loss pnl_pct lessons learned do not deploy rugpull bundle`
- **MANAGER**: `position management rules: trailing take profit stop loss out of range rebalance sentinel il mitigation`
- **GENERAL**: goal-as-is

Results are injected into the system prompt as a "RELEVANT PAST EXPERIENCE" section above the reasoning template.

### Architecture Modes (`runScreener()` in `agent.js`)

Wraps the screener in 4 configurable modes, applied in order of priority:

| Mode | Config | Behavior | When to use |
|------|--------|----------|-------------|
| **Tournament** | `screeningTournamentEnabled: true` + `screeningTournamentOpponent: <model>` | Run screening with both models in parallel. Deploy only if both agree on the same pool. Disagreement → NO DEPLOY. | When you have 2 models with different biases. Conservative pick. |
| **Self-Consistency** | `screeningSelfConsistencyN: 3` (or N) | Run screening N times. Majority vote on the deployed pool. No majority → NO DEPLOY. | When model is uncertain. N=3 is typical. |
| **Two-Stage** | `screeningTwoStageEnabled: true` + `screeningTwoStageModel: <cheap-model>` | Stage 1: cheap model gets the full candidate list and emits a JSON shortlist (top 3-5). Stage 2: top model decides on the shortlist. | When full list is large or top model is expensive. |
| **Default** | all flags false | Single `agentLoop` call with `screeningModel`. | Default. |

All three modes are **off by default** — opt-in via `user-config.json`. To enable two-stage: set `screeningTwoStageEnabled: true` and `screeningTwoStageModel: "openrouter/hunter-alpha"` (or any cheap model).

### Decision-Log Integration

`decision-log.json` now has a `conviction` field. The manager prompt's "RECENT DECISIONS" section shows the last 6 decisions with their conviction scores for cross-cycle trend analysis.

---

## MANAGEMENT Performance Layer

The manager was rebuilt for higher-quality close/claim decisions. All improvements are backward-compatible and gated behind new config keys (default = previous behavior, with new pre-computed data + auto-Sentinel on top).

### Trajectory Metrics (`position-metrics.js`)

For every open position, `computePositionMetrics()` returns a pre-computed bundle:

| Metric | Source | LLM use |
|--------|--------|---------|
| `pnl_velocity_per_hour` | PnL drift over last 6 snapshots | Detect yield collapse / healthy trend |
| `fee_velocity_per_hour` | Fees drift over last 6 snapshots | Detect fee death |
| `drawdown_from_peak_pct` | `peak_pnl - current_pnl` | Approaching trail trigger? |
| `time_in_range_pct` | In-range count over last 6 snapshots | OOR majority? |
| `lifecycle` | `early (<2h)` / `mid (2-24h)` / `late (>24h)` | Different rules per stage |
| `estimated_close_cost_pct` | `estCloseCostSol / value` | Worth closing for marginal gain? |
| `hints[]` | auto-aggregated flags | Pre-formatted bullets for LLM |

Metrics are computed for every open position but the LLM is only called when action is needed (existing STAY-skip optimization preserved).

### Auto-Sentinel (`index.js` runManagementCycle)

Sentinel is now auto-triggered at the start of every management cycle for **action positions only** (saves RPC). The LLM goal gets pre-evaluated `regime`, `P_exit`, `IL`, and `recommendation` for each. The LLM can skip the `sentinel_analyze` tool call unless it needs a fresh eval (>5 min old).

Cooldown still gates rebalances (`config.sentinel.control.rebalanceCooldownSec` = 300s default). Emergency override (`|IL| ≥ 15%`) bypasses cooldown and forces `close_position`.

### Comparable Alternative Yield (`index.js`)

The top screener candidate's fee/TVL is fetched at the start of the management cycle and injected into the LLM goal as `COMPARABLE ALTERNATIVE`. Helps the LLM weigh "stay vs close-to-redeploy" with real opportunity-cost data.

Disable via `management.comparableAltEnabled: false`.

### JS-Side Instruction Parser (`position-metrics.js`)

Simple instructions are now parsed in JavaScript before reaching the LLM:

| Pattern | Parsed type |
|---------|-------------|
| `close at 5% profit`, `hold until +3%` | `TAKE_PROFIT` |
| `close if down 10%`, `stop loss 5%` | `STOP_LOSS` |
| `close if pnl < -5%`, `close if pnl > 5%` | `TAKE_PROFIT` / `STOP_LOSS` |
| `close after 2h`, `exit after 30m` | `TIME_LIMIT` |
| anything else | unparseable → LLM evaluates |

When parsed + met → automatic `CLOSE` action. When parsed + not met → automatic `STAY` (skips LLM entirely). When unparseable → falls through to LLM with the raw instruction.

### Multi-Position Portfolio View (`index.js`)

LLM gets a `PORTFOLIO VIEW` block showing weakest/best positions, total exposure, and weighted PnL. Enables rebalance-style thinking: "weakest is -8%, best is +5% — close weakest and let best run."

### Drawdown Guard (`state.js` + `position-metrics.js`)

If `drawdown_from_peak / peak_pnl >= drawdownGuardPct` (default 50%), the position is marked with `INSTRUCTION: drawdown_guard` and routed to the LLM with full context. A "force exit" mode (`drawdownGuardForceExit: true`) bypasses LLM and deterministically closes — reserved slot, NOT YET IMPLEMENTED.

### Closed-Position Feedback (`index.js` buildClosedFeedback)

LLM gets a `RECENT CLOSES` block showing the last 3 closed positions with PnL, fees, and reason. Enables the LLM to learn from its own recent actions. Pulls from `lessons.json` performance log.

### Briefing Improvement (`briefing.js`)

Daily Telegram briefing now shows:
- 24h + 7d PnL, fees, win rate
- Close reason breakdown (e.g. `low yield=3, oor=1`)
- Sentinel avg reward (24h + 7d)
- Active pool cooldowns

### New Config Keys (`config.js`)

| Key | Default | Purpose |
|-----|---------|---------|
| `management.estCloseCostSol` | 0.005 | Estimated close + swap gas in SOL |
| `management.minCloseWorthinessSol` | 0.05 | Min pnl_gain - close_cost to consider close |
| `management.drawdownGuardPct` | 50 | % of peak PnL that triggers soft-stop |
| `management.autoSentinelEnabled` | true | Auto-run Sentinel for action positions |
| `management.comparableAltEnabled` | true | Fetch top candidate fee/TVL as alt yield |
| `management.drawdownGuardForceExit` | false | Bypass LLM on drawdown guard (reserved) |
| `llm.management.temperature` | 0.25 (was 0.373) | Slightly more deterministic |

### New Tool: `get_position_health`

One-call comprehensive snapshot combining trajectory + Sentinel + hints. Saves 2-3 tool calls per position.

Tool input: `{ position_address, pool_address }`. Returns:
- Live position data
- Trajectory metrics + hints
- Sentinel pre-eval (regime, P_exit, IL, recommendation)
- Aggregated action hints

Available in `MANAGER_TOOLS`, `INTENT_TOOLS.close`, `INTENT_TOOLS.claim`, `INTENT_TOOLS.sentinel`, `INTENT_TOOLS.positions`.

### Better Swap (`tools/wallet.js`)

`swap_token` now accepts `slippageBps` parameter (default 50 = 0.5%). Returns `slippage_bps` and `price_impact_pct` in the response. For low-liquidity base tokens, LLM can pass 100-150 bps.

### Prompt Restructure (`prompt.js` MANAGER)

The MANAGER section now opens with a **DECISION FRAMEWORK** — a 7-step walk-through:
1. Is the alert already triggered? (close/claim rule)
2. Is the instruction met? (JS-parsed or LLM-eval)
3. Trajectory check (yield collapse + drawdown)
4. Close worthiness (cost vs gain)
5. Sentinel check (auto-eval provided)
6. Comparable alternative (stay vs redeploy)
7. Default: HOLD

Then `BEHAVIORAL CORE` (patience, gas efficiency, after-close swap, slippage, Sentinel, untrusted data).

### Backward Compatibility

All new keys default to previous behavior. Set `management.autoSentinelEnabled: false` to disable auto-Sentinel. Set `management.comparableAltEnabled: false` to disable alt yield. Temperature change is opt-in via `managementTemperature` in `user-config.json`.

### Smoke Test

`node test_position_metrics.mjs` runs 19 tests covering parseInstruction, evaluateInstruction, and computePositionMetrics. All pass.

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.js`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Known issue**: `evolveThresholds()` references `maxVolatility` and `minFeeTvlRatio` but config.js uses `minFeeActiveTvlRatio` and has no `maxVolatility` key — the evolution of these keys is a no-op

## Hindsight Memory Layer

`hindsight.js` is an optional biomimetic memory service that runs separately as a Docker container (port 8888). When `HINDSIGHT_ENABLED=true` and the service is reachable, Meridian augments its local JSON memory (`lessons.json`, `pool-memory.json`, `strategy-library.json`) with structured retain/recall/reflect.

**Operations:**
- `retain(bank, content, opts)` — store world facts, experiences, or mental models
- `recall(bank, query, opts)` — search using 4 parallel strategies: semantic vectors, BM25 keywords, entity/temporal/causal graph, time range. Fused via RRF + cross-encoder rerank.
- `reflect(bank, query, opts)` — deep analysis that derives new insights from existing memories

**Banks** (prefix configurable via `hindsight.bankPrefix`, default `meridian`):
- `{prefix}_lessons`      — closed-position rules and outcomes
- `{prefix}_pools`        — per-pool facts, deploy history, snapshots, cooldowns, operator notes
- `{prefix}_strategies`   — LP strategy library (defaults + custom)
- `{prefix}_reflections`  — mental models from periodic auto-reflect

**Auto-wiring:**
- `lessons.js → recordPerformance()` retains the lesson + performance to the `lessons` bank
- `pool-memory.js → recordPoolDeploy()` retains the deploy outcome to the `pools` bank
- `pool-memory.js → addPoolNote()` retains operator notes to the `pools` bank
- `strategy-library.js → addStrategy()` retains the strategy to the `strategies` bank
- Every 5 closed positions, `hindsightReflect()` runs a deep reflection on accumulated performance and retains the result to `reflections`
- If `hindsight.autoRecall` is true, `agent.js → agentLoop()` calls `recallLessons()` before each LLM call and injects results as a "RELEVANT PAST EXPERIENCE" section in the system prompt

**Tools exposed to the LLM** (in `tools/definitions.js`):
- `recall_memory` — search a bank with a natural-language query
- `reflect_on_memory` — derive insights from a bank
- `retain_memory` — explicitly store a memory (auto-capture covers most cases)

**Fail-safe:** When Hindsight is disabled, unreachable, or the npm client is not installed, every call returns `null`/`[]` and Meridian keeps using local JSON files. No code path depends on Hindsight being up.

**Setup:**
1. `npm install` (pulls `@vectorize-io/hindsight-client`)
2. Edit `docker-compose.yml` to uncomment one `HINDSIGHT_API_LLM_*` block (OpenAI/Anthropic/Ollama)
3. `docker compose up -d hindsight` — wait for `http://localhost:8888/health` to return 200
4. Set `hindsightEnabled: true` in `user-config.json` (or `HINDSIGHT_ENABLED=true` in `.env`)
5. Optional: set `hindsightAutoRecall: true` to inject recall results into the system prompt

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.js`. It uses built-in Agent Meridian defaults unless overridden by config or env.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## DLMM Sentinel Skill (Impermanent Loss Mitigation)

`tools/sentinel.js` implements a 4-module skill for active IL management on Meteora DLMM:

1. **SENSING** — `fetchPositionState()` pulls live `active_bin`, `position_pnl`, and on-chain state.
2. **ANTICIPATION** — `classifyRegime()` (LOW_VOL_SIDEWAYS / HIGH_VOL_TRENDING / MEAN_REVERTING) and `calculateBinExitProbability()` (normal-distribution P_exit over Δt).
3. **MITIGATION** — `recommendAction()` produces one of: `REBALANCE_SHAPE`, `TIGHTEN_SHAPE`, `ASYMMETRIC_LADDER`, `HEDGE_DELTA`, `EMERGENCY_WITHDRAW`, `HOLD`. Respects a cooldown gate (default 300s).
4. **LEARNING** — `calculateReward()` implements R_t = α·F − β·ΔIL − γ·C − λ·P. Records every evaluation to `sentinel-state.json` and retains to Hindsight (fail-safe).

**Regime → shape mapping:**
| Regime | Shape | Rationale |
|--------|-------|-----------|
| `LOW_VOL_SIDEWAYS` | `bid_ask` | Concentrate tightly to harvest dynamic fees |
| `HIGH_VOL_TRENDING` | `curve` | Spread horizontally, slow IL |
| `MEAN_REVERTING` | `spot` (asymmetric) | Laddered TP or buy-the-dip |
| `EMERGENCY` (`|IL|≥15%`) | `withdraw` | Full exit to stable |

**Tools exposed to the LLM** (in `tools/definitions.js`):
- `sentinel_analyze` — full 4-module evaluation (SENSING → ANTICIPATION → MITIGATION → LEARNING)
- `sentinel_calculate_reward` — R_t calculator
- `sentinel_classify_regime` — regime classifier
- `sentinel_calculate_p_exit` — bin-exit probability
- `sentinel_calculate_il` — AMM IL
- `sentinel_get_status` — view weights + recent reward history
- `sentinel_set_weights` — tune α,β,γ,λ at runtime
- `sentinel_set_thresholds` — tune P_exit / IL / regime cutoffs
- `sentinel_evaluate_closed` — post-mortem reward capture (called from `lessons.js` on close)

**Auto-wiring:**
- `agent.js` exposes all Sentinel tools to `MANAGER_TOOLS` and to the `close` / `claim` / `sentinel` GENERAL intents
- `prompt.js` MANAGER section injects a 1-line reminder ("DLMM SENTINEL: call before any non-trivial action…")
- `lessons.js → recordPerformance()` calls `evaluateClosedPosition()` to feed the closed outcome into the reward signal
- `strategy-library.js` ships a `dlmm_sentinel` meta-strategy that documents the regime → shape contract
- Every Sentinel evaluation is auto-retained to Hindsight's pools bank (fail-safe)

**Configuration** (`config.sentinel`, overridable in `user-config.json`):
- `weights.{alpha,beta,gamma,lambda}` — R_t coefficients. β is the IL penalty, default 2.0 (highest).
- `thresholds.{pExitLow, pExitHigh, ilPctHedge, ilPctEmergency, volHighThreshold, trendStrongThreshold, meanReversionThreshold}`
- `control.{rebalanceCooldownSec, maxSlippagePct, hedgingSizePct}` — defaults match the spec: 300s cooldown, 0.3% max slippage, 50% delta-hedge sizing at 2% IL

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` evolves `maxVolatility` + `minFeeTvlRatio` (wrong key names — should be `minFeeActiveTvlRatio`; `maxVolatility` doesn't exist in config at all). The evolution is a no-op for those keys.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
- `runScreener()` self-consistency / tournament / two-stage modes are opt-in. Default behavior unchanged.
- Conviction enforcement is LOG-ONLY (analytics) — the deploy has already happened by the time we parse the score. The agent is supposed to self-enforce via the MANDATORY PRE-DEPLOY SELF-CHECK section in the prompt.
- `management.drawdownGuardForceExit` is reserved (NOT YET IMPLEMENTED). Currently drawdown guard is a soft hint to LLM, not a deterministic exit.
- `fee_velocity_per_hour` uses `unclaimed_fees_usd` snapshot diff, which conflates claim events with organic fee growth. Use as a noisy indicator only, not as a hard signal.
