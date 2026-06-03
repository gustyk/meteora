import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance", "get_position_health", "recall_memory", "reflect_on_memory", "retain_memory", "sentinel_analyze", "sentinel_calculate_reward", "sentinel_classify_regime", "sentinel_calculate_p_exit", "sentinel_calculate_il", "sentinel_get_status", "sentinel_set_weights", "sentinel_set_thresholds", "sentinel_evaluate_closed"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions", "recall_memory", "reflect_on_memory", "retain_memory"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Tools the LLM is allowed to call after the max-same-tool-streak guard fires.
// Research/data-gathering tools are stripped — only deploy/action tools remain
// so the LLM is forced to commit to a decision instead of iterating.
const ACTION_TOOLS_BY_ROLE = {
  SCREENER: new Set(["deploy_position"]),
  MANAGER:  new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_position_health", "get_wallet_balance", "get_my_positions"]),
};
function filterActionTools(fullList, agentType) {
  const allowed = ACTION_TOOLS_BY_ROLE[agentType];
  if (!allowed) return fullList;
  return fullList.filter(t => allowed.has(t.function.name));
}

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_position_health", "get_wallet_balance", "swap_token", "sentinel_analyze", "sentinel_calculate_reward", "sentinel_evaluate_closed", "sentinel_get_status", "sentinel_set_weights", "sentinel_set_thresholds"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_position_health", "get_wallet_balance", "sentinel_analyze", "sentinel_calculate_reward", "sentinel_get_status"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  sentinel:    new Set(["sentinel_analyze", "sentinel_calculate_reward", "sentinel_classify_regime", "sentinel_calculate_p_exit", "sentinel_calculate_il", "sentinel_get_status", "sentinel_set_weights", "sentinel_set_thresholds", "sentinel_evaluate_closed", "get_my_positions", "get_position_pnl", "get_position_health"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_position_health", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["recall_memory", "reflect_on_memory", "retain_memory", "get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "sentinel",    re: /\b(sentinel|il risk|impermanent|rebalance|shape shift|market regime|reward function|bin.?exit)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";
import { isAvailable as hindsightAvailable, recallLessons as hindsightRecallLessons, formatRecallResults } from "./hindsight.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

/**
 * Resolve decoding parameters for a given agent role.
 * Falls back to global llm.temperature if per-role not set.
 */
function getDecodingParams(agentType) {
  const llm = config.llm || {};
  const role = llm[(agentType || "general").toLowerCase()] || {};
  return {
    temperature:     role.temperature     ?? llm.temperature ?? 0.373,
    top_p:           role.topP            ?? 0.9,
    presence_penalty:role.presencePenalty ?? 0,
    frequency_penalty:role.frequencyPenalty?? 0,
  };
}

/**
 * Extract a conviction score (1-10) from a screening response.
 * Looks for "CONVICTION: <n>" line; falls back to scanning the last
 * few lines for "conviction" or "score" patterns. Returns null if not found.
 */
export function extractConvictionScore(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Primary pattern: "CONVICTION: <n>" or "CONVICTION: <n>/10" (case-insensitive, integers only)
  const m1 = cleaned.match(/CONVICTION\s*[:=]\s*(\d{1,2})(?:\s*\/\s*10)?(?!\.)/i);
  if (m1) {
    const n = Number(m1[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 10) return n;
  }
  // Fallback: "score: 8/10", "conviction 7"
  const m2 = cleaned.match(/(?:conviction|score|confidence)[^.\n]{0,30}?(\d{1,2})\s*\/\s*10/i);
  if (m2) {
    const n = Number(m2[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 10) return n;
  }
  return null;
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

function isThinkingModeToolChoiceError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /thinking mode does not support/i.test(message) && /tool_choice/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  // Hindsight auto-recall: if enabled, surface relevant past lessons/strategies
  // for this goal. Fail-safe — no-op when Hindsight is disabled/unreachable.
  let hindsightContext = null;
  if (config.hindsight?.enabled && config.hindsight?.autoRecall && hindsightAvailable() && goal) {
    try {
      // Per-role recall query shaping — SCREENER wants precedent on
      // "similar profile" deploys, MANAGER wants position management rules,
      // GENERAL wants the goal as-is.
      let recallQuery;
      if (agentType === "SCREENER") {
        recallQuery = `screening precedent outcomes: tokens with similar mcap volatility organic_score smart_wallets deploy win loss pnl_pct lessons learned do not deploy rugpull bundle`;
      } else if (agentType === "MANAGER") {
        recallQuery = `position management rules: trailing take profit stop loss out of range rebalance sentinel il mitigation`;
      } else {
        recallQuery = goal;
      }
      const recallQueryFinal = `${recallQuery} ${goal}`.slice(0, 500);
      const recalled = await hindsightRecallLessons(recallQueryFinal, { limit: config.hindsight.recallLimit || 6 });
      hindsightContext = formatRecallResults(recalled, { maxChars: config.hindsight.recallMaxChars || 1800 });
      if (hindsightContext) {
        log("hindsight", `Injected ${recalled.length} recalled memory item(s) for ${agentType} goal`);
      }
    } catch (error) {
      log("hindsight_warn", `auto-recall failed: ${error.message}`);
    }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary, hindsightContext);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;
  // Stays true for the whole run once a thinking-mode provider rejects tool_choice
  let omitToolChoice = false;
  // Issue 10: count how many tool calls in this cycle produced malformed JSON
  // (the LLM emitted something JSON.parse could not consume). Surfaces
  // unreliable models and gives post-mortem a single metric to look at.
  let malformedJSONCount = 0;
  // Issue 11: track recent tool names so we can break out of loops where the
  // LLM calls the same tool over and over (e.g. 7× check_smart_wallets_on_pool)
  // without making any decision. After MAX_SAME_TOOL_STREAK we inject a forced
  // synthesis message that requires the agent to commit to an action.
  const toolCallStreak = [];
  const MAX_SAME_TOOL_STREAK = 4;
  let maxSameToolGuardFired = false;
  // Issue 12: once the guard fires, strip research tools and only offer
  // deploy/action tools for the remaining steps. Prevents the common pattern
  // where the LLM switches from check_smart_wallets to get_token_info after
  // the guard message, burning another 10 steps on the same "data gathering
  // without deciding" loop.
  let actionToolsOnly = false;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const reqParams = {
            model: usedModel,
            messages,
            tools: actionToolsOnly
              ? filterActionTools(getToolsForRole(agentType, goal), agentType)
              : getToolsForRole(agentType, goal),
            ...getDecodingParams(agentType),
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          if (!omitToolChoice) reqParams.tool_choice = toolChoice;
          response = await client.chat.completions.create(reqParams);
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          if (!omitToolChoice && isThinkingModeToolChoiceError(error)) {
            omitToolChoice = true;
            log("agent", "Provider thinking mode does not support tool_choice — retrying without it");
            attempt -= 1;
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      const invalidToolArgErrors = new Map();
      // Keep tool-call history API-valid, but never execute unrecoverable args.
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              malformedJSONCount += 1;
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name} (count=${malformedJSONCount})`);
              } catch {
                tc.function.arguments = "{}";
                const error = `Invalid tool arguments for ${tc.function.name}`;
                invalidToolArgErrors.set(tc.id, error);
                log("error", `${error}: could not repair JSON (count=${malformedJSONCount})`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        log(
          "agent_summary",
          `cycle ended: steps=${step + 1} malformed_json=${malformedJSONCount} same_tool_guard_fired=${maxSameToolGuardFired}`
        );
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        if (invalidToolArgErrors.has(toolCall.id)) {
          const result = {
            success: false,
            error: invalidToolArgErrors.get(toolCall.id),
            blocked: true,
          };
          await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
        }

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          malformedJSONCount += 1;
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName} (count=${malformedJSONCount})`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message} (count=${malformedJSONCount})`);
            const result = {
              success: false,
              error: `Invalid tool arguments for ${functionName}`,
              blocked: true,
            };
            await onToolFinish?.({ name: functionName, args: {}, result, success: false, step });
            return {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          const isDeploy = functionName === "deploy_position";
          const blockedReason = isDeploy
            ? `deploy_position was already executed this session — whether it succeeded, was blocked by safety checks, or was a dry-run simulation, you MUST NOT retry it. Treat the result you received as final. Report the outcome and end the cycle.`
            : `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`;
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: blockedReason },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: blockedReason }),
          };
        }

        // Issue 11: track the tool-call streak. If the LLM has called the same
        // tool MAX_SAME_TOOL_STREAK times in a row, force a synthesis decision
        // by injecting a follow-up user message that demands an action.
        if (toolCallStreak[toolCallStreak.length - 1] !== functionName) {
          toolCallStreak.length = 0;
        }
        toolCallStreak.push(functionName);
        if (toolCallStreak.length >= MAX_SAME_TOOL_STREAK && !maxSameToolGuardFired) {
          maxSameToolGuardFired = true;
          actionToolsOnly = true;
          log(
            "agent",
            `Same-tool streak guard fired: ${functionName} called ${toolCallStreak.length}× in a row — action-only mode`
          );
          toolCallStreak.length = 0;
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              __guard__: "max_same_tool_streak",
              message:
                `You have called ${functionName} ${MAX_SAME_TOOL_STREAK}+ times in a row. ` +
                `All research/data-gathering tools have been REMOVED. You now have access to only action tools ` +
                `(e.g. deploy_position, close_position, swap_token). ` +
                `Commit to a decision NOW. If the goal is to deploy, call deploy_position with a specific pool ` +
                `from the candidates you already have data on. Otherwise, end the cycle with NO DEPLOY.`,
            }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  log(
    "agent_summary",
    `cycle ended: steps=${maxSteps} malformed_json=${malformedJSONCount} same_tool_guard_fired=${maxSameToolGuardFired}`
  );
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Screening wrappers: two-stage / self-consistency / tournament ──

/**
 * Stage-1 of two-stage screening: cheap model shortlists top-N candidates.
 * Returns an array of candidate "names" (pool name strings) extracted from a
 * JSON object the model emits. Falls back to [] on any parse failure.
 *
 * The goal should be a self-contained summary of the candidates (no on-chain
 * tools required). This is a TEXT-IN, JSON-OUT task with temperature 0.
 */
async function stage1Shortlist(goal, model) {
  const stage1Prompt = `${goal}

TASK: Pick the top 3-5 most promising pools from the list above based ONLY on the pre-computed composite_score, smart_wallets, narrative_quality, and memory_flag fields. Do NOT do any tool calls. Output ONLY a JSON object — no prose, no markdown, no explanation.

FORMAT (strict):
{"shortlist": ["POOL NAME 1", "POOL NAME 2", "POOL NAME 3"]}

If nothing looks promising, output:
{"shortlist": []}
`;
  try {
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are a fast pre-filter. Output ONLY valid JSON. No prose. No markdown." },
        { role: "user", content: stage1Prompt },
      ],
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
    });
    const text = res.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(jsonrepair(text));
    const list = Array.isArray(parsed.shortlist) ? parsed.shortlist : [];
    return list.map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
  } catch (error) {
    log("warn", `stage1Shortlist failed: ${error.message}`);
    return [];
  }
}

/**
 * Filter a pre-built candidate goal down to only the named shortlist.
 * The goal contains "POOL: <name> ... <pool address>" blocks separated by
 * blank lines. We keep blocks whose `POOL:` line matches a shortlist name.
 */
function filterGoalByShortlist(goal, shortlist) {
  if (!Array.isArray(shortlist) || shortlist.length === 0) return goal;
  const blocks = goal.split(/\n\n+/);
  const lower = new Set(shortlist.map((s) => s.toLowerCase()));
  const keepBlocks = blocks.filter((block) => {
    const m = block.match(/^POOL:\s*([^\n(]+?)\s*\(/);
    if (!m) return false;
    return lower.has(m[1].trim().toLowerCase());
  });
  return keepBlocks.length > 0 ? keepBlocks.join("\n\n") : goal;
}

/**
 * Stage-2 of two-stage screening: top model does final decision on shortlist.
 * Same call shape as the original agentLoop but with a filtered goal.
 */
async function stage2Decide(goal, options) {
  return agentLoop(goal, config.llm.maxSteps, [], "SCREENER", options.screeningModel, 2048, options.callbacks || {});
}

/**
 * Extract the deployed pool name from a screening response.
 * Looks for the "POOL: <name> (address)" line in the "DEPLOYED" block, or
 * the "BEST LOOKING CANDIDATE" line in a NO DEPLOY report.
 */
function extractDeployedName(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/gi, "");
  // DEPLOYED case
  const m1 = cleaned.match(/🚀\s*DEPLOYED[\s\S]*?POOL:\s*([^\n(]+?)\s*\(/i);
  if (m1) return m1[1].trim();
  // Fallback: first POOL: <name> after DEPLOYED marker
  if (/🚀\s*DEPLOYED/i.test(cleaned)) {
    const m1b = cleaned.match(/POOL:\s*([^\n(]+?)\s*\(/);
    if (m1b) return m1b[1].trim();
  }
  return null;
}

/**
 * Extract a "no deploy" outcome marker from a screening response.
 * Returns true if the response is a NO DEPLOY report.
 */
function isNoDeployReport(text) {
  if (!text) return false;
  return /⛔\s*NO DEPLOY/i.test(String(text).replace(/<think>[\s\S]*?<\/think>/gi, ""));
}

/**
 * High-level screening wrapper. Supports four modes:
 *   1. default: single agentLoop call
 *   2. two-stage: cheap model shortlists → top model decides on shortlist
 *   3. self-consistency: N parallel calls, majority vote
 *   4. tournament: two models, only deploy if BOTH agree
 *
 * Returns the agent's final response shape: { content, userMessage }.
 * The 'silent' option suppresses progress logging.
 */
export async function runScreener(goal, options = {}) {
  const sc = config.llm?.screening || {};
  const callbacks = options.callbacks || {};
  const silent = Boolean(options.silent);
  const screeningModel = options.screeningModel || config.llm.screeningModel;

  // Mode 4: tournament (two models, conservative pick)
  if (sc.tournamentEnabled && sc.tournamentOpponent) {
    const opponent = sc.tournamentOpponent;
    if (!silent) log("screening", `Tournament: ${screeningModel} vs ${opponent} (conservative wins)`);
    const [resA, resB] = await Promise.all([
      agentLoop(goal, config.llm.maxSteps, [], "SCREENER", screeningModel, 2048, callbacks).catch((e) => ({ content: `⛔ NO DEPLOY\n\nTournament model A failed: ${e.message}` })),
      agentLoop(goal, config.llm.maxSteps, [], "SCREENER", opponent, 2048, callbacks).catch((e) => ({ content: `⛔ NO DEPLOY\n\nTournament model B failed: ${e.message}` })),
    ]);
    const aDeploy = !isNoDeployReport(resA?.content) && extractDeployedName(resA?.content);
    const bDeploy = !isNoDeployReport(resB?.content) && extractDeployedName(resB?.content);
    if (aDeploy && bDeploy && aDeploy.toLowerCase() === bDeploy.toLowerCase()) {
      if (!silent) log("screening", `Tournament: both models agree on ${aDeploy} → DEPLOY`);
      return resA;
    }
    // Conservative: pick the one that says NO DEPLOY, or resA's NO DEPLOY if both deploy but disagree
    if (!silent) log("screening", `Tournament: models disagree (A=${aDeploy ?? "no_deploy"}, B=${bDeploy ?? "no_deploy"}) → NO DEPLOY`);
    return { content: `⛔ NO DEPLOY\n\nTournament: models disagree (${screeningModel}=${aDeploy ?? "no_deploy"}, ${opponent}=${bDeploy ?? "no_deploy"}). Conservative pick: no deploy.\n\n---\nMODEL A:\n${resA?.content ?? ""}\n\n---\nMODEL B:\n${resB?.content ?? ""}` };
  }

  // Mode 3: self-consistency (N parallel calls, majority vote)
  const n = Math.max(1, Number(sc.selfConsistencyN) || 1);
  if (n > 1) {
    if (!silent) log("screening", `Self-consistency: ${n} parallel calls`);
    const samples = await Promise.all(
      Array.from({ length: n }).map(() =>
        agentLoop(goal, config.llm.maxSteps, [], "SCREENER", screeningModel, 2048, callbacks)
          .catch((e) => ({ content: `⛔ NO DEPLOY\n\nSelf-consistency sample failed: ${e.message}` }))
      )
    );
    const tally = new Map();
    let noDeployCount = 0;
    for (const s of samples) {
      if (isNoDeployReport(s?.content)) { noDeployCount++; continue; }
      const name = extractDeployedName(s?.content);
      if (name) {
        const key = name.toLowerCase();
        tally.set(key, (tally.get(key) || 0) + 1);
      }
    }
    const winner = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (winner && winner[1] > n / 2) {
      if (!silent) log("screening", `Self-consistency: majority picked ${winner[0]} (${winner[1]}/${n}) → DEPLOY`);
      const matchIdx = samples.findIndex((s) => extractDeployedName(s?.content)?.toLowerCase() === winner[0]);
      return samples[matchIdx >= 0 ? matchIdx : 0];
    }
    if (!silent) log("screening", `Self-consistency: no majority (noDeploy=${noDeployCount}, deploys=${[...tally.values()].join(",")}) → NO DEPLOY`);
    return { content: `⛔ NO DEPLOY\n\nSelf-consistency: no majority across ${n} samples (no_deploy=${noDeployCount}, deploys=${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}). Conservative pick: no deploy.` };
  }

  // Mode 2: two-stage (cheap filter → top model)
  if (sc.twoStageEnabled && sc.twoStageModel) {
    const filterModel = sc.twoStageModel;
    if (!silent) log("screening", `Two-stage: filter=${filterModel}, decider=${screeningModel}, limit=${sc.twoStageLimit}`);
    const shortlist = await stage1Shortlist(goal, filterModel);
    if (shortlist.length === 0) {
      if (!silent) log("screening", `Two-stage: filter produced empty shortlist → NO DEPLOY`);
      return { content: "⛔ NO DEPLOY\n\nTwo-stage filter produced empty shortlist. Nothing passed the cheap filter." };
    }
    if (!silent) log("screening", `Two-stage: shortlist=[${shortlist.join(", ")}]`);
    const filteredGoal = filterGoalByShortlist(goal, shortlist);
    if (filteredGoal === goal) {
      if (!silent) log("screening_warn", `Two-stage: shortlist names did not match any blocks; falling back to full goal`);
    }
    return stage2Decide(filteredGoal, { ...options, screeningModel });
  }

  // Mode 1: default single call
  return agentLoop(goal, config.llm.maxSteps, [], "SCREENER", screeningModel, 2048, callbacks);
}
