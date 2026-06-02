/**
 * Hindsight memory client wrapper.
 *
 * Hindsight is a biomimetic agent memory system with three operations:
 *   - retain:   store information (world facts, experiences, mental models)
 *   - recall:   search memories (semantic + BM25 + graph + temporal, fused via RRF)
 *   - reflect:  deep analysis — derive new insights from existing memories
 *
 * Docs: https://hindsight.vectorize.io
 *
 * Bank layout for Meridian (prefix configurable via hindsight.bankPrefix):
 *   - {prefix}_lessons:      closed-position lessons + performance records
 *   - {prefix}_pools:        per-pool facts, deploy history, snapshots, cooldowns
 *   - {prefix}_strategies:   LP strategy library (default + custom)
 *   - {prefix}_reflections:  mental models derived via reflect()
 *
 * Design rules:
 *   - Lazy init. Connection attempted on first call, not at startup.
 *   - Fail-safe. If HINDSIGHT_URL is unset, the service is down, or the
 *     npm client is missing, every call returns null/[] and logs a warning.
 *     Meridian keeps using its local JSON files (lessons.json, pool-memory.json,
 *     strategy-library.json) for memory.
 *   - Non-blocking. retain() is fire-and-forget by default; callers do not
 *     await memory writes that would slow down the hot deploy/close path.
 */

import { log } from "./logger.js";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL = "http://localhost:8888";
const DEFAULT_BANK_PREFIX = "meridian";
const HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_RECALL_LIMIT = 8;

let _client = null;
let _initPromise = null;
let _available = false;
let _banks = null;
let _healthCheckedAt = 0;
const HEALTH_TTL_MS = 60_000;

async function getHindsightConfig() {
  try {
    // Dynamic import to avoid circular dep at module load (config.js is
    // imported by many modules that may also touch hindsight).
    const mod = await import("./config.js");
    return mod.config?.hindsight || {};
  } catch {
    return {};
  }
}

async function loadClientModule() {
  try {
    const mod = await import("@vectorize-io/hindsight-client");
    return mod.HindsightClient || mod.default?.HindsightClient || null;
  } catch (error) {
    return { __error: error };
  }
}

async function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const cfg = await getHindsightConfig();
    if (!cfg.enabled) {
      log("hindsight", "Disabled in config — using local JSON files only");
      return null;
    }

    const baseUrl = (cfg.baseUrl || process.env.HINDSIGHT_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

    const HindsightClient = await loadClientModule();
    if (!HindsightClient || HindsightClient.__error) {
      const msg = HindsightClient?.__error?.message || "unknown";
      log("hindsight_warn", `@vectorize-io/hindsight-client not installed (${msg}) — install with: npm i @vectorize-io/hindsight-client`);
      _available = false;
      return null;
    }

    _client = new HindsightClient({ baseUrl });

    // Health probe — short timeout, cached for HEALTH_TTL_MS.
    const now = Date.now();
    if (now - _healthCheckedAt > HEALTH_TTL_MS) {
      _healthCheckedAt = now;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
        const res = await fetch(`${baseUrl}/health`, { signal: controller.signal }).catch(() => null);
        clearTimeout(timer);
        _available = res?.ok === true;
      } catch {
        _available = false;
      }
    }

    if (_available) {
      const prefix = cfg.bankPrefix || DEFAULT_BANK_PREFIX;
      _banks = {
        lessons:     `${prefix}_lessons`,
        pools:       `${prefix}_pools`,
        strategies:  `${prefix}_strategies`,
        reflections: `${prefix}_reflections`,
      };
      log("hindsight", `Connected to ${baseUrl} (banks: ${Object.values(_banks).join(", ")})`);
    } else {
      log("hindsight_warn", `Hindsight unreachable at ${baseUrl} — falling back to local JSON`);
    }
    return _client;
  })();
  return _initPromise;
}

export function isAvailable() {
  return _available;
}

export function getBanks() {
  return _banks;
}

/**
 * Force a fresh health probe. Returns whether Hindsight is reachable.
 */
export async function ping() {
  _healthCheckedAt = 0;
  await init();
  return _available;
}

// ─── Bootstrap: ensure Hindsight is running at agent startup ──────

const COMPOSE_PATH = path.join(__dirname, "docker-compose.yml");
const STARTUP_GRACE_MS = 25_000;
const STARTUP_PROBE_INTERVAL_MS = 1_500;

function tryDockerComposeUp(timeoutMs) {
  return new Promise((resolve) => {
    if (!existsSync(COMPOSE_PATH)) {
      resolve({ started: false, reason: "no docker-compose.yml" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    const child = spawn("docker", ["compose", "-f", COMPOSE_PATH, "up", "-d", "hindsight"], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      resolve({ started: false, reason: `docker compose timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!killed) resolve({ started: false, reason: `docker not available: ${err.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ started: true, stdout: stdout.trim() });
      } else {
        resolve({ started: false, reason: `docker compose exited ${code}: ${stderr.trim().slice(0, 300)}` });
      }
    });
  });
}

async function waitForHealthy(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    _healthCheckedAt = 0; // force a fresh probe
    await init();
    if (_available) return true;
    await new Promise((r) => setTimeout(r, STARTUP_PROBE_INTERVAL_MS));
  }
  return false;
}

/**
 * Auto-bootstrap: called at agent startup.
 *
 * - If Hindsight is already reachable, no-op.
 * - If URL is the default localhost:8888, attempt to bring up the
 *   Docker container defined in docker-compose.yml.
 * - Otherwise, just probe and log; assume the user manages the
 *   service externally.
 *
 * Best-effort: never throws. Always returns a status the caller can log.
 */
export async function bootstrap({ timeoutMs = STARTUP_GRACE_MS } = {}) {
  const cfg = await getHindsightConfig();
  const result = {
    enabled: !!cfg.enabled,
    started: false,
    reachable: false,
    skipped: null,
    error: null,
  };

  if (!cfg.enabled) {
    result.skipped = "disabled in config";
    return result;
  }

  // 1. Probe first
  _healthCheckedAt = 0;
  await init();
  if (_available) {
    result.reachable = true;
    return result;
  }

  const baseUrl = (cfg.baseUrl || process.env.HINDSIGHT_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(baseUrl);

  if (!isLocal) {
    result.skipped = `HINDSIGHT_URL=${baseUrl} is non-local; start the service externally.`;
    return result;
  }

  // 2. Try to bring it up via docker compose
  log("hindsight", `Hindsight unreachable at ${baseUrl} — attempting docker compose up -d`);
  const composeResult = await tryDockerComposeUp(Math.min(15_000, timeoutMs));
  if (!composeResult.started) {
    result.error = composeResult.reason;
    log("hindsight_warn", `docker compose up failed: ${composeResult.reason} — agent will keep using local JSON files`);
    return result;
  }
  result.started = true;
  log("hindsight", "docker compose up -d succeeded; waiting for healthy…");

  // 3. Wait for the service to come up
  const healthy = await waitForHealthy(Math.max(0, timeoutMs - 15_000));
  result.reachable = healthy;
  if (!healthy) {
    result.error = `Hindsight container started but did not become healthy within ${timeoutMs}ms`;
    log("hindsight_warn", result.error);
  } else {
    log("hindsight", "Hindsight is healthy — memory layer active");
  }
  return result;
}

// ─── Core operations ─────────────────────────────────────────────

/**
 * Store information in Hindsight.
 * @param {string} bank
 * @param {string} content
 * @param {Object} [opts]
 * @param {string} [opts.context]   - context label
 * @param {string} [opts.timestamp] - ISO timestamp
 * @param {Object} [opts.metadata]  - structured metadata (entity tags)
 * @returns {Promise<any|null>}
 */
export async function retain(bank, content, opts = {}) {
  await init();
  if (!_available || !_client) return null;
  try {
    return await _client.retain(bank, content, {
      context: opts.context,
      timestamp: opts.timestamp || new Date().toISOString(),
      metadata: opts.metadata,
    });
  } catch (error) {
    log("hindsight_warn", `retain failed: ${error.message}`);
    return null;
  }
}

/**
 * Search memories.
 * @param {string} bank
 * @param {string} query
 * @param {Object} [opts]
 * @param {number} [opts.maxTokens] - token budget forwarded to client
 * @param {string} [opts.queryTimestamp] - "as of" timestamp
 * @returns {Promise<Array>}
 */
export async function recall(bank, query, opts = {}) {
  await init();
  if (!_available || !_client) return [];
  try {
    const clientOpts = {};
    if (opts.maxTokens) clientOpts.maxTokens = opts.maxTokens;
    if (opts.queryTimestamp) clientOpts.queryTimestamp = opts.queryTimestamp;
    const result = await _client.recall(bank, query, clientOpts);
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.results)) return result.results;
    if (Array.isArray(result?.memories)) return result.memories;
    return [];
  } catch (error) {
    log("hindsight_warn", `recall failed: ${error.message}`);
    return [];
  }
}

/**
 * Deep analysis on existing memories.
 * @param {string} bank
 * @param {string} query
 * @param {Object} [opts]
 * @returns {Promise<string|null>}
 */
export async function reflect(bank, query, opts = {}) {
  await init();
  if (!_available || !_client) return null;
  try {
    const result = await _client.reflect(bank, query, opts);
    if (typeof result === "string") return result;
    if (typeof result?.response === "string") return result.response;
    if (typeof result?.text === "string") return result.text;
    if (typeof result?.answer === "string") return result.answer;
    return JSON.stringify(result);
  } catch (error) {
    log("hindsight_warn", `reflect failed: ${error.message}`);
    return null;
  }
}

// ─── Meridian-specific helpers ───────────────────────────────────

export async function retainLesson(lesson, performance) {
  if (!_available || !_banks) return null;
  const text = [
    `[${(lesson.outcome || "neutral").toUpperCase()}] ${lesson.rule}`,
    lesson.context ? `Context: ${lesson.context}` : null,
    `PnL: ${performance.pnl_pct ?? 0}% ($${performance.pnl_usd ?? 0})`,
    `Range efficiency: ${performance.range_efficiency ?? 0}%`,
    `Strategy: ${performance.strategy || "n/a"}, volatility: ${performance.volatility ?? "n/a"}, fee_tvl: ${performance.fee_tvl_ratio ?? "n/a"}`,
    `Close reason: ${performance.close_reason || "n/a"}`,
  ].filter(Boolean).join("\n");

  return retain(_banks.lessons, text, {
    context: `lesson:${lesson.outcome || "manual"}`,
    timestamp: lesson.created_at,
    metadata: {
      type: "lesson",
      outcome: lesson.outcome,
      tags: lesson.tags || [],
      confidence: lesson.confidence,
      pool: performance.pool,
      pnl_pct: performance.pnl_pct,
    },
  });
}

export async function retainPoolFact(poolAddress, fact, opts = {}) {
  if (!_available || !_banks) return null;
  return retain(_banks.pools, fact, {
    context: opts.context || `pool:${poolAddress}`,
    timestamp: opts.timestamp,
    metadata: { type: "pool_fact", pool: poolAddress, ...(opts.metadata || {}) },
  });
}

export async function retainPoolDeploy(deploy, poolEntry) {
  if (!_available || !_banks) return null;
  const text = [
    `Pool: ${poolEntry?.name || deploy.pool_address?.slice(0, 8)}`,
    `Outcome: ${deploy.pnl_pct >= 0 ? "PROFIT" : "LOSS"} — PnL ${deploy.pnl_pct}%, fees $${deploy.fees_earned_usd ?? 0}`,
    `Strategy: ${deploy.strategy}, volatility at deploy: ${deploy.volatility_at_deploy ?? "n/a"}`,
    `Range efficiency: ${deploy.range_efficiency ?? 0}%, held ${deploy.minutes_held ?? 0}m`,
    `Close reason: ${deploy.close_reason || "n/a"}`,
  ].join("\n");

  return retain(_banks.pools, text, {
    context: `pool_deploy:${deploy.pool_address}`,
    timestamp: deploy.closed_at,
    metadata: {
      type: "pool_deploy",
      pool: deploy.pool_address,
      pnl_pct: deploy.pnl_pct,
      outcome: deploy.pnl_pct >= 0 ? "profit" : "loss",
      strategy: deploy.strategy,
    },
  });
}

export async function retainStrategy(strategy) {
  if (!_available || !_banks) return null;
  const text = [
    `Strategy: ${strategy.name} (${strategy.id})`,
    `Author: ${strategy.author}`,
    `LP type: ${strategy.lp_strategy}`,
    `Token criteria: ${JSON.stringify(strategy.token_criteria)}`,
    `Entry: ${JSON.stringify(strategy.entry)}`,
    `Range: ${JSON.stringify(strategy.range)}`,
    `Exit: ${JSON.stringify(strategy.exit)}`,
    `Best for: ${strategy.best_for}`,
  ].join("\n");

  return retain(_banks.strategies, text, {
    context: `strategy:${strategy.id}`,
    timestamp: strategy.added_at || new Date().toISOString(),
    metadata: {
      type: "strategy",
      id: strategy.id,
      lp_strategy: strategy.lp_strategy,
      author: strategy.author,
    },
  });
}

export async function recallLessons(query, opts = {}) {
  if (!_available || !_banks) return [];
  return recall(_banks.lessons, query, opts);
}

export async function recallPoolFacts(poolAddress, query, opts = {}) {
  if (!_available || !_banks) return [];
  const q = query || `pool ${poolAddress} history performance deploys cooldowns`;
  return recall(_banks.pools, q, opts);
}

export async function recallStrategies(query) {
  if (!_available || !_banks) return [];
  return recall(_banks.strategies, query || "active LP strategy");
}

/**
 * Periodic deep reflection on accumulated performance. Result is auto-retained
 * to the reflections bank for future reference.
 */
export async function reflectOnPerformance(opts = {}) {
  if (!_available || !_banks) return null;
  const query = opts.query
    || "What patterns distinguish winning positions from losing ones? Any actionable rules I should add to screening thresholds or position management?";
  const text = await reflect(_banks.lessons, query, { context: "auto_reflection" });
  if (text) {
    void retain(_banks.reflections, text, {
      context: "auto_reflection",
      timestamp: new Date().toISOString(),
      metadata: { type: "reflection", source: "auto", positions: opts.positions },
    });
  }
  return text;
}

/**
 * Format recall results into a prompt-injectable block. Falls back to
 * a single line per result. Keeps total length bounded.
 */
export function formatRecallResults(results, { maxChars = 2000, maxItems = 6 } = {}) {
  if (!results || results.length === 0) return null;
  const lines = [];
  let used = 0;
  for (const r of results.slice(0, maxItems)) {
    const text = r.content || r.text || r.memory || r.fact || JSON.stringify(r);
    const line = `- ${String(text).replace(/\s+/g, " ").slice(0, 280)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
