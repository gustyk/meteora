const toolDefinitions = [
  // ═══════════════════════════════════════════
  //  SCREENING TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "discover_pools",
      description: `Fetch top DLMM pools from the Meteora Pool Discovery API.
Pools are pre-filtered for safety:
- No critical warnings on base/quote tokens
- No high single ownership on base token
- Base token market cap >= $150k
- Base token holders >= 100
- Volume >= $1k (in timeframe)
- Active TVL >= $10k
- Fee/Active TVL ratio >= 0.01 (in timeframe)
- Both tokens organic score >= 60

Returns condensed pool data: address, name, tokens, bin_step, fee_pct,
active_tvl, fee_window, volume_window, fee_tvl_ratio, volatility from max(timeframe, 30m), organic_score,
holders, mcap, active_positions, price_change_pct, warning count.

Use this as the primary tool for finding new LP opportunities.`,
      parameters: {
        type: "object",
        properties: {
          page_size: {
            type: "number",
            description: "Number of pools to return. Default 50. Use 10-20 for quick scans."
          },
          timeframe: {
            type: "string",
            enum: ["1h", "4h", "12h", "24h"],
            description: "Timeframe for metrics. Use 24h for general screening, 1h for momentum."
          },
          category: {
            type: "string",
            enum: ["top", "new", "trending"],
            description: "Pool category. 'top' = highest fee/TVL, 'new' = recently created, 'trending' = gaining activity."
          }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_top_candidates",
      description: `Get the top pre-scored pool candidates for deployment review.
All filtering, scoring, and rule-checking is done in code — no analysis needed.
Returns the top N eligible pools ranked by score (fee/TVL, organic, stability, volume).
Each pool includes a score (0-100) and has already passed all hard disqualifiers.
Use this instead of discover_pools for screening cycles.
If this returns one candidate, still judge whether it is actually worth deploying; one weak candidate should be skipped.`,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of top candidates to return. Default 3."
          }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_pool_detail",
      description: `Get detailed info for a specific DLMM pool by address.
Use this during management to check current pool health (volume, fees, organic score, price trend).
Default timeframe is 5m for real-time accuracy during position management.
Use a longer timeframe (1h, 4h) only when screening for new deployments.

IMPORTANT: Only call this with a real pool address from get_my_positions or get_top_candidates. Never guess or construct a pool address.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The on-chain pool address (base58 public key)"
          },
          timeframe: {
            type: "string",
            enum: ["5m", "15m", "30m", "1h", "2h", "4h", "12h", "24h"],
            description: "Data timeframe. Default 5m for management (most accurate). Use 4h+ for screening."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  POSITION DEPLOYMENT TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_active_bin",
      description: `Get the current active bin and price for a DLMM pool.
This is an on-chain call via the SDK. Returns:
- binId: the current active bin number
- price: human-readable price (token X per token Y)
- pricePerLamport: raw price in lamports

Only call this if you need the current price to calculate a specific bin range (e.g. user requested a % range). Do NOT call before every deploy — deploy_position fetches the active bin internally.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address"
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "deploy_position",
      description: `Open a new DLMM liquidity position.

PRIORITY ORDER for strategy and bins:
1. User explicitly specifies → always follow exactly (user override is absolute)
2. No user spec → use active strategy's lp_strategy and choose bins based on volatility

HARD RULES:
- Never use 'curve'.
- Bin Step: Only deploy in pools with bin_step between 80 and 125.
- Volatility must be positive. If volatility is 0, null, or missing, do not deploy.
- Range must cover at least 35 total bins. Never deploy 1-bin/tiny ranges.
- For single-side SOL deploys (amount_y only, amount_x=0), do not request upside exposure:
  use bins_below only, keep bins_above=0, and the upper bin will be pinned to the current active bin.

Guidelines (only when user hasn't specified):
- Strategy: use the active strategy's lp_strategy field (bid_ask or spot)
- Bins: choose from configured minBinsBelow/maxBinsBelow by positive volatility. The hard lower floor is 35 bins.
- Deposit: single-sided SOL only: set amount_y/amount_sol, keep amount_x=0.

WARNING: This executes a real on-chain transaction. Check DRY_RUN mode.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The DLMM pool address to LP in"
          },
          amount_y: {
            type: "number",
            description: "Amount of quote token (usually SOL) to deposit."
          },
          amount_x: {
            type: "number",
            description: "Unsupported for this agent. Keep at 0; deploys are single-side SOL via amount_y."
          },
          amount_sol: {
            type: "number",
            description: "Alias for amount_y. For backward compatibility."
          },
          strategy: {
            type: "string",
            enum: ["bid_ask", "spot"],
            description: "DLMM strategy type. If user specifies, use exactly what they said. Otherwise use the active strategy's lp_strategy field."
          },
          bins_below: {
            type: "number",
            description: "Number of bins below the current active bin. For single-side SOL deploys, this is the main range input: lower bin = active bin - bins_below, upper bin = active bin."
          },
          bins_above: {
            type: "number",
            description: "Number of bins above the current active bin. Keep this at 0 for single-side SOL deploys. Only use this for dual-sided or explicit upside-exposure deploys."
          },
          downside_pct: {
            type: "number",
            description: "Optional human-friendly downside range in percent below the current active price. Converted to bins internally via the Meteora SDK."
          },
          upside_pct: {
            type: "number",
            description: "Optional human-friendly upside range in percent above the current active price. Do not use this for single-side SOL deploys."
          },
          pool_name: { type: "string", description: "Human-readable pool name for record-keeping" },
          base_mint: { type: "string", description: "Base token mint address — used to prevent duplicate token exposure across pools" },
          bin_step: { type: "number", description: "Pool bin step (from discover_pools)" },
          base_fee: { type: "number", description: "Pool base fee percentage (from discover_pools)" },
          volatility: { type: "number", description: "Pool volatility at deploy time, sourced from max(screening timeframe, 30m)" },
          fee_tvl_ratio: { type: "number", description: "fee/TVL ratio at deploy time" },
          organic_score: { type: "number", description: "Base token organic score at deploy time" },
          initial_value_usd: { type: "number", description: "Estimated USD value being deployed" }
        },
        required: ["pool_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  POSITION MANAGEMENT TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_position_pnl",
      description: `Get detailed PnL and real-time Fee/TVL metrics for an open position.
Use this during management to check if yield has dropped significantly.
Returns current feePerTvl24h which indicates the current APY of the pool.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "The pool address" },
          position_address: { type: "string", description: "The position public key" }
        },
        required: ["pool_address", "position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_my_positions",
      description: `List all open DLMM positions for the agent wallet.
Returns positions grouped by pool, each with:
- position address
- pool address and token pair
- bin range (min/max bin IDs)
- whether currently in range
- unclaimed fees (in USD)
- total deposited value vs current value
- time since last rebalance

Use this at the start of every management cycle.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  {
    type: "function",
    function: {
      name: "claim_fees",
      description: `Claim accumulated swap fees from a specific position.
Only call when unclaimed fees > $5 to justify transaction costs.
Returns the transaction hash and amounts claimed.

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to claim fees from"
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "close_position",
      description: `Remove all liquidity and close a position.
This withdraws all tokens back to the wallet and closes the position account.
Use when:
- Position has been out of range for > 30 minutes
- IL exceeds accumulated fees
- Token shows danger signals (organic score drop, volume crash)
- Rebalancing (close old + open new)

WARNING: This executes a real on-chain transaction. Cannot be undone.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position public key to close"
          },
          skip_swap: {
            type: "boolean",
            description: "Set to true if user explicitly wants to hold/keep the base token after closing. Default: false (auto-swaps base token back to SOL)."
          },
          reason: {
            type: "string",
            description: "Why this position is being closed. Include the rule that triggered it, e.g. 'low yield', 'stop loss', 'trailing TP', 'OOR'. Used for pool memory."
          }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_wallet_positions",
      description: `Get all open DLMM positions for any Solana wallet address.
Use this when the user asks about another wallet's positions, wants to monitor a wallet,
or wants to copy/compare positions.

Returns the same structure as get_my_positions but for the given wallet:
position address, pool, bin range, in-range status, unclaimed fees, PnL, age.`,
      parameters: {
        type: "object",
        properties: {
          wallet_address: {
            type: "string",
            description: "The Solana wallet address (base58 public key) to check"
          }
        },
        required: ["wallet_address"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  WALLET TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: `Get current wallet balances for SOL, USDC, and all other token holdings.
Returns:
- SOL balance (native)
- USDC balance
- Other SPL token balances with USD values
- Total portfolio value in USD

Use to check available capital before deploying positions.`,
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  {
    type: "function",
    function: {
      name: "swap_token",
      description: `Swap tokens via Jupiter aggregator.
Use when you need to rebalance wallet holdings, e.g.:
- Convert claimed fee tokens back to SOL/USDC
- Prepare token pair before deploying a position

WARNING: This executes a real on-chain transaction.`,
      parameters: {
        type: "object",
        properties: {
          input_mint: {
            type: "string",
            description: "Mint address of the token to sell"
          },
          output_mint: {
            type: "string",
            description: "Mint address of the token to buy"
          },
          amount: {
            type: "number",
            description: "Amount of input token to swap (in human-readable units, not lamports)"
          },
        },
        required: ["input_mint", "output_mint", "amount"]
      }
    }
  },

  // ═══════════════════════════════════════════
  //  LEARNING TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "update_config",
      description: `Update any of your operating parameters at runtime.
Changes persist to user-config.json and take effect immediately — no restart needed.

VALID KEYS (use EXACTLY these key names, nothing else):
Screening: minFeeActiveTvlRatio, minTvl, maxTvl, minVolume, minOrganic, minQuoteOrganic, minHolders, minMcap, maxMcap, minBinStep, maxBinStep, timeframe, category, minTokenFeesSol, excludeHighSupplyConcentration, allowedLaunchpads, blockedLaunchpads
Management: minClaimAmount, outOfRangeBinsToClose, outOfRangeWaitMinutes, oorCooldownTriggerCount, oorCooldownHours, repeatDeployCooldownEnabled, repeatDeployCooldownTriggerCount, repeatDeployCooldownHours, repeatDeployCooldownScope, repeatDeployCooldownMinFeeEarnedPct, minVolumeToRebalance, stopLossPct, takeProfitPct, minSolToOpen, deployAmountSol, gasReserve, positionSizePct
Risk: maxPositions, maxDeployAmount
Schedule: managementIntervalMin, screeningIntervalMin
Models: managementModel, screeningModel, generalModel
Strategy: minBinsBelow, maxBinsBelow, defaultBinsBelow (legacy binsBelow maps to maxBinsBelow)

Reason is optional but helpful — logged as a lesson when provided.`,
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "object",
            description: "Key-value pairs of settings to update. e.g. { \"takeProfitPct\": 8 }"
          },
          reason: {
            type: "string",
            description: "Why you are making this change — what you observed that justified it"
          }
        },
        required: ["changes"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "self_update",
      description: `Pull the latest code from git and restart the agent.
Use when the user says "update", "pull latest", "update yourself", etc.
Responds with what changed before restarting in 3 seconds.`,
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "get_recent_decisions",
      description: `Get the recent structured decision log for deployments, closes, skips, and no-deploy outcomes.
Use this when the user asks explanatory questions like:
- why did you deploy that position?
- why did you close that pool?
- why didn't you deploy anything?

This is the preferred tool for answering "why did you..." questions because it returns the agent's recorded reasoning without requiring unrelated live trading actions.`,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "How many recent decisions to return. Default 6."
          }
        }
      }
    }
  },

  // ═══════════════════════════════════════════
  //  SMART WALLET TOOLS
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "add_smart_wallet",
      description: `Add a wallet to the smart wallet tracker.
Use when the user says "add smart wallet", "track this wallet", "add to smart wallets", etc.
- type "lp": wallet is tracked for LP positions (checked before deploying). Use for LPers/whales.
- type "holder": wallet is only checked for token holdings (never fetches positions). Use for KOLs/traders who don't LP.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Label for this wallet (e.g. 'alpha-1', 'whale-sol')" },
          address: { type: "string", description: "Solana wallet address (base58)" },
          category: { type: "string", enum: ["alpha", "smart", "fast", "multi"], description: "Wallet category (default: alpha)" },
          type: { type: "string", enum: ["lp", "holder"], description: "lp = tracks LP positions, holder = tracks token holdings only (default: lp)" }
        },
        required: ["name", "address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_smart_wallet",
      description: "Remove a wallet from the smart wallet tracker.",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "Wallet address to remove" }
        },
        required: ["address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_smart_wallets",
      description: "List all currently tracked smart wallets.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "check_smart_wallets_on_pool",
      description: `Check if any tracked smart wallets have an active position in a given pool.
Use this before deploying to gauge confidence — if smart wallets are in the pool it's a strong signal.
If no smart wallets are present, rely on fundamentals (fees, volume, organic score) as usual.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "Pool address to check" }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_info",
      description: `Get token data from Jupiter (organic score, holders, audit, price stats, mcap).
Use this to research a token before deploying or when the user asks about a token.
Accepts token name, symbol, or mint address as query.

Returns: organic score, holder count, mcap, liquidity, audit flags (mint/freeze disabled, bot holders %), 1h and 24h stats.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Token name, symbol, or mint address" }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_holders",
      description: `Get holder distribution for a token by mint address.
Fetches top 100 holders — use limit to control how many to display (default 20).
Each holder includes: address, amount, % of supply, SOL balance, tags (Pool/AMM/etc), and funding info (who funded this wallet, amount, slot).
is_pool=true means it's a liquidity pool address, not a real holder — filter these out when analyzing concentration.

Also returns global_fees_sol — total priority/jito tips paid by ALL traders on this token (NOT Meteora LP fees).
This is a key signal: low global_fees_sol means transactions are bundled or the token is a scam.
HARD GATE: if global_fees_sol < config.screening.minTokenFeesSol (default 30), do NOT deploy.

NOTE: Requires mint address. If you only have a symbol/name, call get_token_info first to resolve the mint.`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58). Use get_token_info first if you only have a symbol." },
          limit: { type: "number", description: "How many holders to return (default 20, max 100)" }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_token_narrative",
      description: `Get the narrative or story behind a token from Jupiter ChainInsight.
Returns a plain-text description of what the token is about — its origin, theme, community, and activity.
Use during token evaluation to understand if there is a real catalyst driving attention and volume.

GOOD narrative signals (proceed with more confidence):
- Specific origin story: tied to a real-world event, viral moment, person, animal, place, or cultural reference
- Active community: mentions contests, donations, real-world actions, organized activities
- Trending catalyst: references something currently viral on X/CT (KOL call, news event, meme wave)
- Named entities: real identifiable subjects (a specific animal, person, project, game, etc.)

BAD narrative signals (caution or skip):
- Empty or null — no story at all
- Pure hype/financial language only: "next 100x", "to the moon", "fair launch gem" with no substance
- Completely generic: "community-driven token", "meme coin" with zero specific context
- Copy-paste of another token's narrative`,
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address (base58)" }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "search_pools",
      description: `Search for DLMM pools by token symbol, ticker, or contract address (CA).
Use this when the user asks to deploy into a specific token or pool by name/CA,
or when you want to find pools for a specific token outside of the normal screening flow.

Examples: "find pools for ROSIE", "search BONK pools", "look up pool for CA abc123..."

Returns pool address, name, bin_step, fee %, TVL, volume, and token mints.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Token symbol, ticker name, or contract address to search for"
          },
          limit: {
            type: "number",
            description: "Max results to return (default 10)"
          }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_top_lpers",
      description: `Get the top open LPers for a pool by address — quick read-only lookup.
Use this when the user asks "who are the top LPers in this pool?" or wants to
know how others are performing in a specific pool without saving lessons.

Returns: aggregate LPAgent-backed top-LPer patterns from the Agent Meridian
\`/top-lp/:pool\` endpoint. Data is cached server-side and refreshed on a 30m cadence.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The pool address to look up top LPers for"
          },
          limit: {
            type: "number",
            description: "Number of top LPers to return. Default 5."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "study_top_lpers",
      description: `Fetch and analyze top open LPers for a pool to learn from their behaviour.
Returns LPAgent-backed owner aggregates and historical style/range samples from
the Agent Meridian \`/study-top-lp/:pool\` endpoint.

Use this before deploying into a new pool to:
- See if top performers are scalpers (< 1h holds) or long-term holders.
- Match your strategy and range to what is actually working for others right now.
- Avoid pools where even the best open LPs are poorly placed or losing.

Server note: study data is cached and refreshed every 30 minutes.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address to study top LPers for"
          },
          limit: {
            type: "number",
            description: "Number of top LPers to study. Default 4."
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "clear_lessons",
      description: `Remove lessons from memory. Use when the user asks to erase lessons, or when lessons contain bad data (e.g. bug-caused -100% PnL records).

Modes:
- keyword: remove all lessons whose text contains the keyword (e.g. "-100%", "FAILED", "WhiteHouse")
- all: wipe every lesson
- performance: wipe all closed position performance records (the raw data lessons are derived from)`,
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["keyword", "all", "performance"],
            description: "What to clear"
          },
          keyword: {
            type: "string",
            description: "Required when mode=keyword. Case-insensitive substring match against lesson text."
          }
        },
        required: ["mode"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "set_position_note",
      description: `Save a persistent instruction for a position that ALL future management cycles will respect.
Use this immediately whenever the user gives a specific instruction about a position:
- "hold until 5% profit"
- "don't close before fees hit $10"
- "close if it goes out of range"
- "hold for at least 2 hours"

The instruction is stored in state.json and injected into every management cycle prompt.
Pass null or empty string to clear an existing instruction.`,
      parameters: {
        type: "object",
        properties: {
          position_address: {
            type: "string",
            description: "The position address to attach the instruction to"
          },
          instruction: {
            type: "string",
            description: "The instruction to persist (e.g. 'hold until PnL >= 5%'). Pass empty string to clear."
          }
        },
        required: ["position_address", "instruction"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "add_lesson",
      description: `Save a lesson to the agent's permanent memory.
Use after studying top LPers or observing a pattern worth remembering.
Lessons are injected into the system prompt on every future cycle.
Write concrete, actionable rules — not vague observations.

Use 'role' to target a specific agent type so it only appears in the right context.
Use 'pinned: true' for critical rules that must always be present regardless of memory cap.

Examples:
- rule: "PREFER: pools where top LPers hold < 30 min", tags: ["scalping"], role: "SCREENER"
- rule: "AVOID: closing when OOR < 30min — price often recovers", tags: ["oor"], role: "MANAGER", pinned: true`,
      parameters: {
        type: "object",
        properties: {
          rule: {
            type: "string",
            description: "The lesson rule — specific and actionable"
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags e.g. ['narrative', 'screening', 'oor', 'fees', 'management']"
          },
          role: {
            type: "string",
            enum: ["SCREENER", "MANAGER", "GENERAL"],
            description: "Which agent role this lesson applies to. Omit for all roles."
          },
          pinned: {
            type: "boolean",
            description: "Pin this lesson so it's always injected regardless of memory cap. Use for critical rules."
          }
        },
        required: ["rule"]
      }
    }
  },

  // ─── Strategy Library ──────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_strategy",
      description: `Save a new LP strategy to the strategy library.
Use when the user pastes a tweet or description of a strategy.
Parse the text and extract structured criteria, then call this tool to store it.
The strategy will be available for selection before future deployments.`,
      parameters: {
        type: "object",
        properties: {
          id:           { type: "string", description: "Short slug e.g. 'overnight_classic_bid_ask', 'panda_strat'" },
          name:         { type: "string", description: "Human-readable name" },
          author:       { type: "string", description: "Strategy author/creator" },
          lp_strategy:  { type: "string", enum: ["bid_ask", "spot", "curve"], description: "LP strategy type" },
          token_criteria: {
            type: "object",
            description: "Token selection criteria",
            properties: {
              min_mcap:      { type: "number", description: "Minimum market cap in USD" },
              min_age_days:  { type: "number", description: "Minimum token age in days" },
              requires_kol:  { type: "boolean", description: "Requires KOL presence" },
              notes:         { type: "string", description: "Additional token selection notes" }
            }
          },
          entry: {
            type: "object",
            description: "Entry conditions",
            properties: {
              condition:                    { type: "string", description: "Entry condition description" },
              price_change_threshold_pct:   { type: "number", description: "Price change % that triggers entry (e.g. -30 for -30% from ATH)" },
              single_side:                  { type: "string", description: "sol or token" }
            }
          },
          range: {
            type: "object",
            description: "Bin range configuration",
            properties: {
              type:           { type: "string", enum: ["tight", "default", "wide", "panda"], description: "Range type (tight 10-30%, default 40-57%, wide 60%+, panda 85-90%)" },
              bins_below_pct: { type: "number", description: "How far below entry price the range covers (%)" },
              notes:          { type: "string" }
            }
          },
          exit: {
            type: "object",
            properties: {
              take_profit_pct: { type: "number", description: "Take profit threshold %" },
              notes:           { type: "string" }
            }
          },
          best_for: { type: "string", description: "Short description of ideal market conditions for this strategy" },
          raw:      { type: "string", description: "Original tweet or text the strategy was parsed from" }
        },
        required: ["id", "name"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_strategies",
      description: "List all saved strategies in the library with a summary of each. Shows which one is currently active.",
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "get_strategy",
      description: "Get full details of a specific strategy including all criteria, range settings, and original raw text.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Strategy ID from list_strategies" }
        },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "set_active_strategy",
      description: `Set which strategy to use for the next screening/deployment cycle.
The active strategy's token criteria, entry conditions, range, and exit rules will be applied.
Call list_strategies first to see available options.`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Strategy ID to activate" }
        },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_strategy",
      description: "Remove a strategy from the library.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Strategy ID to remove" }
        },
        required: ["id"]
      }
    }
  },

  // ─── Lesson Management ─────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "list_lessons",
      description: `Browse saved lessons with optional filters.
Use to find a lesson ID before pinning/unpinning, or to audit what the agent currently knows.`,
      parameters: {
        type: "object",
        properties: {
          role:   { type: "string", enum: ["SCREENER", "MANAGER", "GENERAL"], description: "Filter by role" },
          pinned: { type: "boolean", description: "Filter to only pinned (true) or unpinned (false) lessons" },
          tag:    { type: "string", description: "Filter by a specific tag" },
          limit:  { type: "number", description: "Max lessons to return (default 30)" }
        }
      }
    }
  },

  {
    type: "function",
    function: {
      name: "pin_lesson",
      description: `Pin a lesson by ID so it's always injected into the prompt regardless of memory cap.
Use for critical rules that must never be forgotten — e.g. narrative criteria, hard risk rules.
Call list_lessons first to find the lesson ID.`,
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Lesson ID (from list_lessons)" }
        },
        required: ["id"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "unpin_lesson",
      description: "Unpin a previously pinned lesson. It will re-enter the normal rotation.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Lesson ID to unpin" }
        },
        required: ["id"]
      }
    }
  },

  // ─── Performance History ────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_performance_history",
      description: `Retrieve closed position records filtered by time window.
Use when the user asks about recent performance, last 24h positions, how you've been doing, P&L history, etc.
Returns individual closed positions with PnL, fees, strategy, hold time, and close reason.`,
      parameters: {
        type: "object",
        properties: {
          hours: {
            type: "number",
            description: "How many hours back to look (default 24). Use 168 for last 7 days."
          },
          limit: {
            type: "number",
            description: "Max records to return (default 50)"
          }
        }
      }
    }
  },

  // ─── Pool Memory ────────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "get_pool_memory",
      description: `Check your deploy history for a pool BEFORE deploying.
Returns all past deploys, PnL, win rate, and any notes you've added.

Call this tool before deploying to any pool — you may have been here before and it didn't work.
Also useful during screening to skip pools with a bad track record.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The pool address to look up"
          }
        },
        required: ["pool_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "add_pool_note",
      description: `Annotate a pool with a freeform note that persists across sessions.
Use when you observe something worth remembering about a specific pool:
- "volume dried up after 2h — avoid during off-hours"
- "consistently good during Asian session"
- "rugged base token — monitor closely"`,
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "Pool address to annotate"
          },
          note: {
            type: "string",
            description: "The note to save"
          }
        },
        required: ["pool_address", "note"]
      }
    }
  },

  // ─── Token Blacklist ────────────────────────────────────────────

  {
    type: "function",
    function: {
      name: "add_to_blacklist",
      description: `Permanently blacklist a base token mint so it's never deployed into again.
Use when a token rugs, shows wash trading, or is otherwise unsafe.
Blacklisted tokens are filtered BEFORE the LLM even sees pool candidates.`,
      parameters: {
        type: "object",
        properties: {
          mint: {
            type: "string",
            description: "The base token mint address to blacklist"
          },
          symbol: {
            type: "string",
            description: "Token symbol (for readability)"
          },
          reason: {
            type: "string",
            description: "Why this token is being blacklisted"
          }
        },
        required: ["mint", "reason"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "remove_from_blacklist",
      description: "Remove a token mint from the blacklist (e.g. if it was added by mistake).",
      parameters: {
        type: "object",
        properties: {
          mint: {
            type: "string",
            description: "The mint address to remove from the blacklist"
          }
        },
        required: ["mint"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "list_blacklist",
      description: "List all blacklisted token mints with their reasons and timestamps.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "block_deployer",
      description: "Block a deployer wallet address. Any token deployed by this wallet will be hard-filtered from screening before the LLM ever sees it.",
      parameters: {
        type: "object",
        properties: {
          wallet:  { type: "string", description: "Deployer wallet address (base58)" },
          label:   { type: "string", description: "Human-readable label (e.g. 'known rugger')" },
          reason:  { type: "string", description: "Why this deployer is being blocked" },
        },
        required: ["wallet"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "unblock_deployer",
      description: "Remove a deployer wallet from the blocklist.",
      parameters: {
        type: "object",
        properties: {
          wallet: { type: "string", description: "Deployer wallet address to unblock" },
        },
        required: ["wallet"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_blocked_deployers",
      description: "List all blocked deployer wallets.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },

  // ─── Hindsight memory tools ───────────────────────────────
  // Hindsight is a biomimetic memory service that runs separately
  // (Docker container, port 8888). When enabled in config, every
  // closed position, pool fact, and strategy is auto-retained;
  // these tools let you query the memory layer directly.
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: `Search the Hindsight memory layer for information relevant to a natural-language query.
Returns memories retrieved via 4 parallel strategies: semantic vector search, BM25 keyword, graph (entity/temporal/causal links), and temporal filtering. Results are fused via reciprocal rank fusion and cross-encoder reranked.

Use this when you need context that isn't in the current system prompt — past lessons about a similar setup, pool history for a specific address, prior reflections on a strategy, etc. The memory is organized into banks:
  - lessons:     closed-position rules and outcomes
  - pools:       per-pool facts and deploy history
  - strategies:  LP strategy library
  - reflections: mental models derived from past experience

If Hindsight is disabled or unreachable, returns an empty list — the agent keeps using local JSON files.`,
      parameters: {
        type: "object",
        properties: {
          bank: {
            type: "string",
            enum: ["lessons", "pools", "strategies", "reflections"],
            description: "Which memory bank to search."
          },
          query: {
            type: "string",
            description: "Natural-language search query."
          },
          limit: {
            type: "number",
            description: "Max results to return. Default 6."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reflect_on_memory",
      description: `Deep analysis on the Hindsight memory bank. Uses the reflect operation to derive new insights, mental models, and connections from existing memories — slower than recall but produces higher-level understanding.

Use this for:
  - Pattern analysis across many past positions ("what distinguishes my winners from losers?")
  - Synthesizing lessons from scattered facts
  - Generating actionable rules from raw experience

The reflection is auto-retained to the reflections bank for future recall.`,
      parameters: {
        type: "object",
        properties: {
          bank: {
            type: "string",
            enum: ["lessons", "pools", "strategies", "reflections"],
            description: "Which memory bank to reflect on."
          },
          query: {
            type: "string",
            description: "Question or prompt to reflect on. E.g. 'What patterns lead to OOR closes?'"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "retain_memory",
      description: `Store information into the Hindsight memory layer explicitly. Most memory writes happen automatically (on position close, pool deploy, strategy add). Use this tool when you want to retain an observation, hypothesis, or piece of context that wasn't auto-captured.

Hindsight will internally extract entities, relationships, and temporal data from the content.`,
      parameters: {
        type: "object",
        properties: {
          bank: {
            type: "string",
            enum: ["lessons", "pools", "strategies", "reflections"],
            description: "Which memory bank to write to."
          },
          content: {
            type: "string",
            description: "Free-text content to remember. Be specific — name the pool, the strategy, the metric, the outcome."
          },
          context: {
            type: "string",
            description: "Short label describing the context. E.g. 'pool:OOR-pattern', 'hypothesis:high-fee-strategy'."
          }
        },
        required: ["bank", "content"]
      }
    }
  },

  // ─── DLMM Sentinel tools (Impermanent Loss mitigation) ───────────
  // 4-module skill: SENSING → ANTICIPATION → MITIGATION → LEARNING.
  // Reward signal: R_t = α·F − β·ΔIL − γ·C − λ·P. Tunable via sentinel_set_weights.
  {
    type: "function",
    function: {
      name: "sentinel_analyze",
      description: `Run a full DLMM Sentinel evaluation on a position. The 4-module pipeline:
1) SENSING: fetches active bin, live PnL, and current on-chain state.
2) ANTICIPATION: classifies market regime (LOW_VOL_SIDEWAYS / HIGH_VOL_TRENDING / MEAN_REVERTING) and estimates P_exit (bin-exit probability).
3) MITIGATION: recommends a concrete action — REBALANCE_SHAPE, TIGHTEN_SHAPE, ASYMMETRIC_LADDER, HEDGE_DELTA, EMERGENCY_WITHDRAW, or HOLD. Includes cooldown check and IL emergency override.
4) LEARNING: calculates the reward signal R_t = α·F − β·ΔIL − γ·C − λ·P and records the evaluation to the Sentinel log (and to Hindsight if enabled).

Use this BEFORE any non-trivial management action. The recommendation + cooldown status + IL number should drive your close/claim/rebalance decision.

Returns: { regime, pExit, ilPct, reward, recommendation: { action, reason, targetShape, cooldownOk, ... } }`,
      parameters: {
        type: "object",
        properties: {
          position: {
            type: "object",
            description: "Position descriptor. Must include pool_address; should include position_address, bin range, initial_price, strategy.",
            properties: {
              position_address: { type: "string" },
              pool_address:    { type: "string" },
              strategy:        { type: "string" },
              lower_bin_id:    { type: "number" },
              upper_bin_id:    { type: "number" },
              initial_price:   { type: "number" },
              bin_step:        { type: "number" },
              last_sentinel_eval: { type: "string", description: "ISO timestamp of last Sentinel evaluation for cooldown" },
            },
            required: ["pool_address"]
          },
          volatility:    { type: "number", description: "Current pool volatility (positive number). Omit to use 1.0 fallback." },
          trend:         { type: "number", description: "Recent price trend, -1..1. Default 0." },
          mean_reversion:{ type: "number", description: "Mean-reversion strength, 0..1. Default 0." },
          fees:          { type: "number", description: "Fees earned in this interval (for reward signal). Default 0." },
          gas_cost:      { type: "number", description: "Gas + slippage cost (for reward signal). Default 0." },
          oor_penalty:   { type: "number", description: "0 or 1 — was position OOR? Default 0." }
        },
        required: ["position"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_calculate_reward",
      description: `Compute the Sentinel reward signal R_t = α·F − β·ΔIL − γ·C − λ·P.

Components:
- F: fees earned in the interval
- ΔIL: change in impermanent loss (absolute value used)
- C: gas + slippage cost
- P: 0 or 1 (OOR penalty)

Weights α,β,γ,λ default from config.sentinel.weights. β is typically the highest (IL minimization is the primary objective).`,
      parameters: {
        type: "object",
        properties: {
          fees:       { type: "number", description: "Fees earned." },
          delta_il:   { type: "number", description: "Change in impermanent loss (signed)." },
          gas_cost:   { type: "number", description: "Gas + slippage cost." },
          oor_penalty:{ type: "number", description: "0 or 1 — was position OOR?" },
          weights: {
            type: "object",
            description: "Optional override for α,β,γ,λ.",
            properties: {
              alpha:  { type: "number" },
              beta:   { type: "number" },
              gamma:  { type: "number" },
              lambda: { type: "number" },
            }
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_classify_regime",
      description: "Classify the current market regime from observable signals. Returns one of: LOW_VOL_SIDEWAYS, HIGH_VOL_TRENDING, MEAN_REVERTING.",
      parameters: {
        type: "object",
        properties: {
          volatility:     { type: "number", description: "Current volatility (positive)." },
          trend:          { type: "number", description: "Recent price trend, -1..1." },
          mean_reversion: { type: "number", description: "Mean-reversion strength, 0..1." }
        },
        required: ["volatility"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_calculate_p_exit",
      description: "Estimate the probability that price exits the current bin range within the next Δt minutes (default 5). Uses a normal-distribution model: P(|z| > minDist/σ).",
      parameters: {
        type: "object",
        properties: {
          active_bin_id: { type: "number", description: "Current active bin id." },
          lower_bin_id:  { type: "number", description: "Position's lower bin id." },
          upper_bin_id:  { type: "number", description: "Position's upper bin id." },
          volatility:    { type: "number", description: "Current volatility (positive)." },
          bin_step:      { type: "number", description: "Pool bin step in bps. Default 100." },
          dt_min:        { type: "number", description: "Time horizon in minutes. Default 5." }
        },
        required: ["active_bin_id", "lower_bin_id", "upper_bin_id", "volatility"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_calculate_il",
      description: "Standard AMM impermanent loss for a given price ratio. price_ratio = current_price / initial_price. Returns IL (decimal) and il_pct (percentage).",
      parameters: {
        type: "object",
        properties: {
          price_ratio: { type: "number", description: "current_price / initial_price. e.g. 1.5 for +50% move." }
        },
        required: ["price_ratio"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_get_status",
      description: "View current Sentinel configuration (weights, thresholds, control params) and recent reward history.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_set_weights",
      description: `Tune the reward function weights α,β,γ,λ at runtime. β controls IL penalty and is typically the highest. Persists in memory (process lifetime; not yet persisted to user-config.json).`,
      parameters: {
        type: "object",
        properties: {
          alpha:  { type: "number", description: "Fee weight (positive)." },
          beta:   { type: "number", description: "IL penalty weight (typically highest)." },
          gamma:  { type: "number", description: "Gas/slippage cost weight." },
          lambda: { type: "number", description: "OOR penalty weight." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_set_thresholds",
      description: `Tune Sentinel thresholds: p_exit boundaries, IL hedging/emergency triggers, volatility regime cutoffs. All keys are optional.`,
      parameters: {
        type: "object",
        properties: {
          p_exit_low:           { type: "number", description: "Lower P_exit boundary for tight regime. Default 0.15." },
          p_exit_high:          { type: "number", description: "Upper P_exit boundary for high-vol regime. Default 0.60." },
          il_pct_hedge:         { type: "number", description: "IL % that triggers HEDGE_DELTA. Default 2.0." },
          il_pct_emergency:     { type: "number", description: "IL % that triggers EMERGENCY_WITHDRAW. Default 15.0." },
          vol_high_threshold:   { type: "number", description: "Volatility cutoff for HIGH_VOL regime. Default 3.5." },
          trend_strong_threshold:{ type: "number", description: "|trend| cutoff for HIGH_VOL_TRENDING. Default 0.4." },
          mean_reversion_threshold:{ type: "number", description: "Mean-reversion cutoff. Default 0.6." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sentinel_evaluate_closed",
      description: `Post-mortem reward calculation for a closed position. Records the result to the Sentinel log for future learning. Use after close_position to capture the lesson.`,
      parameters: {
        type: "object",
        properties: {
          fees:        { type: "number", description: "Total fees earned by the position." },
          delta_il:    { type: "number", description: "Net change in IL (signed; +ve = worse than hold)." },
          gas_cost:    { type: "number", description: "Cumulative gas + slippage across rebalances." },
          oor_penalty: { type: "number", description: "0 or 1 — was the position OOR at any point?" }
        },
        required: ["fees", "delta_il"]
      }
    }
  },
];

export const tools = toolDefinitions.map((tool) => ({
  ...tool,
  function: {
    ...tool.function,
    parameters: tool.function.parameters?.type === "object"
      ? { additionalProperties: false, ...tool.function.parameters }
      : tool.function.parameters,
  },
}));
