/**
 * Position analytics — compute trajectory metrics from snapshot history.
 *
 * Used by runManagementCycle to give the LLM a richer view of each open
 * position than a single snapshot. Snapshots live in pool-memory.json and
 * are recorded every management cycle by recordPositionSnapshot().
 *
 * Metrics:
 *   - pnl_velocity_per_hour   — PnL% drift per hour over recent snapshots
 *   - fee_velocity_per_hour   — fees USD per hour over recent snapshots
 *   - drawdown_from_peak_pct  — peak_pnl - current_pnl
 *   - time_in_range_pct       — 0-100, % of recent snapshots in range
 *   - lifecycle               — "early" (0-2h) | "mid" (2-24h) | "late" (>24h)
 *   - estimated_close_cost_pct — close cost as % of position value (gas + slippage)
 *   - next_best_action_hint   — pre-computed string for LLM ("drawdown approaching trail", etc.)
 */

import { getPoolSnapshots } from "./pool-memory.js";

const TRAJECTORY_WINDOW = 6; // last 6 snapshots (~30min at 5min intervals)
const EARLY_HOURS = 2;
const LATE_HOURS = 24;

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bucketLifecycle(ageMinutes) {
  if (ageMinutes < EARLY_HOURS * 60) return "early";
  if (ageMinutes < LATE_HOURS * 60) return "mid";
  return "late";
}

function computeHourSpan(snaps) {
  if (!snaps || snaps.length < 2) return 0;
  const first = new Date(snaps[0].ts).getTime();
  const last = new Date(snaps[snaps.length - 1].ts).getTime();
  return Math.max(0, (last - first) / 3_600_000);
}

function computePnlVelocity(snaps) {
  if (!snaps || snaps.length < 2) return null;
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  if (first.pnl_pct == null || last.pnl_pct == null) return null;
  const hours = computeHourSpan(snaps);
  if (hours <= 0) return null;
  return Number(((last.pnl_pct - first.pnl_pct) / hours).toFixed(3));
}

function computeFeeVelocity(snaps) {
  // Unclaimed fees are a snapshot-in-time metric, not cumulative.
  // Fee velocity = (last unclaimed - first unclaimed) / hours, but this conflates
  // claim events with organic fee growth. We use it as a noisy indicator only.
  if (!snaps || snaps.length < 2) return null;
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  if (first.unclaimed_fees_usd == null || last.unclaimed_fees_usd == null) return null;
  const hours = computeHourSpan(snaps);
  if (hours <= 0) return null;
  return Number(((last.unclaimed_fees_usd - first.unclaimed_fees_usd) / hours).toFixed(4));
}

function computeTimeInRange(snaps) {
  if (!snaps || snaps.length === 0) return null;
  const known = snaps.filter((s) => s.in_range === true || s.in_range === false);
  if (known.length === 0) return null;
  const inRange = known.filter((s) => s.in_range === true).length;
  return Number(((inRange / known.length) * 100).toFixed(1));
}

/**
 * Build next-best-action hint strings the LLM can scan quickly.
 */
function buildHints(metrics, config) {
  const hints = [];

  if (metrics.drawdown_from_peak_pct != null && metrics.drawdown_from_peak_pct >= (config.management.trailingDropPct ?? 1.5) * 0.7) {
    hints.push(`drawdown approaching trail trigger (${metrics.drawdown_from_peak_pct.toFixed(2)}% from peak, threshold ${config.management.trailingDropPct}%)`);
  }

  if (metrics.pnl_velocity_per_hour != null && metrics.pnl_velocity_per_hour < -3) {
    hints.push(`pnl_velocity declining (${metrics.pnl_velocity_per_hour.toFixed(2)}%/hr — yield collapsing)`);
  } else if (metrics.pnl_velocity_per_hour != null && metrics.pnl_velocity_per_hour > 3) {
    hints.push(`pnl_velocity healthy (${metrics.pnl_velocity_per_hour.toFixed(2)}%/hr)`);
  }

  if (metrics.fee_velocity_per_hour != null && metrics.fee_velocity_per_hour < 0) {
    hints.push(`fee_velocity negative ($${metrics.fee_velocity_per_hour.toFixed(4)}/hr — declining fees)`);
  } else if (metrics.fee_velocity_per_hour != null && metrics.fee_velocity_per_hour > 0) {
    hints.push(`fee_velocity positive ($${metrics.fee_velocity_per_hour.toFixed(4)}/hr — accumulating)`);
  }

  if (metrics.time_in_range_pct != null && metrics.time_in_range_pct < 50) {
    hints.push(`time_in_range low (${metrics.time_in_range_pct}% — OOR majority)`);
  }

  if (metrics.estimated_close_cost_pct != null && metrics.estimated_close_cost_pct >= 5) {
    hints.push(`close cost high (${metrics.estimated_close_cost_pct.toFixed(2)}% of value — only close for material gain)`);
  }

  if (metrics.lifecycle === "early" && metrics.minutes_held < 60) {
    hints.push(`early lifecycle (${metrics.minutes_held}m) — give the position time to develop`);
  } else if (metrics.lifecycle === "late" && metrics.minutes_held > 24 * 60) {
    hints.push(`late lifecycle (${(metrics.minutes_held / 60).toFixed(1)}h) — consider re-evaluating`);
  }

  return hints;
}

/**
 * Parse a simple instruction string into a structured close condition.
 * Returns null if the instruction is too complex for JS-side evaluation.
 *
 * Supported patterns:
 *   "close at 5% profit"        → { type: "TAKE_PROFIT", threshold: 5 }
 *   "close if down 10%"         → { type: "STOP_LOSS", threshold: -10 }
 *   "close if pnl < -5%"        → { type: "STOP_LOSS", threshold: -5 }
 *   "hold until +3% pnl"        → { type: "TAKE_PROFIT", threshold: 3 }
 *   "close after 2h"            → { type: "TIME_LIMIT", minutes: 120 }
 *   "close after 24h"           → { type: "TIME_LIMIT", minutes: 1440 }
 *
 * Returns { type, threshold/minutes, raw } or null.
 */
export function parseInstruction(instruction) {
  if (!instruction) return null;
  const text = String(instruction).toLowerCase().trim();

  // Close if pnl < X (most specific — handle first)
  let m = text.match(/pnl\s*([<>]=?)\s*(-?\d+(?:\.\d+)?)\s*%?/i);
  if (m) {
    const op = m[1];
    const n = Number(m[2]);
    if (Number.isFinite(n)) {
      if (op === "<" || op === "<=") {
        return { type: n >= 0 ? "TAKE_PROFIT" : "STOP_LOSS", threshold: n, raw: instruction };
      }
      // > or >= — "if pnl > 5%" means take profit when pnl exceeds 5%
      return { type: "TAKE_PROFIT", threshold: n, raw: instruction };
    }
  }

  // Stop loss: "close if down X%", "stop loss X%", "close if loses X%"
  m = text.match(/(?:close|stop|loss|exit)[^.\n]{0,30}?(?:-|down|loses|loss)[^.\n]{0,10}?(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) {
      return { type: "STOP_LOSS", threshold: -Math.abs(n), raw: instruction };
    }
  }

  // Take profit: "close at X% profit", "hold until X%", "tp X%"
  m = text.match(/(?:close|hold|exit|tp|profit)[^.\n]{0,30}?(\+?\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) {
      return { type: "TAKE_PROFIT", threshold: Math.abs(n), raw: instruction };
    }
  }

  // Time limit: "close after 2h", "exit after 30m"
  m = text.match(/(?:close|exit|hold)[^.\n]{0,30}?(\d+(?:\.\d+)?)\s*(h|hr|hour|hours|m|min|minute|minutes)\b/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const minutes = unit.startsWith("h") ? n * 60 : n;
    if (Number.isFinite(minutes) && minutes > 0) {
      return { type: "TIME_LIMIT", minutes: Math.round(minutes), raw: instruction };
    }
  }

  return null; // unparseable — leave for LLM
}

/**
 * Compute the full analytics bundle for a position.
 *
 * @param {Object} params
 * @param {string} params.pool_address
 * @param {string} params.position_address
 * @param {Object} params.positionData     — fields from getMyPositions: pnl_pct, in_range, etc.
 * @param {Object} params.positionRecord   — record from state.json: peak_pnl_pct, deployed_at, etc.
 * @param {Object} params.config           — live config object
 * @param {number} [params.estCloseCostSol] — estimated close + swap gas cost in SOL (default 0.005)
 */
export function computePositionMetrics({
  pool_address,
  position_address,
  positionData = {},
  positionRecord = {},
  config,
  estCloseCostSol = 0.005,
}) {
  const snaps = getPoolSnapshots(pool_address, { limit: TRAJECTORY_WINDOW, position: position_address });
  const deployedAt = positionRecord.deployed_at;
  const ageMinutes = deployedAt
    ? Math.floor((Date.now() - new Date(deployedAt).getTime()) / 60000)
    : numberOrNull(positionData.age_minutes);

  const pnlVelocity = computePnlVelocity(snaps);
  const feeVelocity = computeFeeVelocity(snaps);
  const timeInRangePct = computeTimeInRange(snaps);
  const currentPnl = numberOrNull(positionData.pnl_pct);
  const peakPnl = numberOrNull(positionRecord.peak_pnl_pct);
  const drawdownFromPeak = (currentPnl != null && peakPnl != null)
    ? Number((peakPnl - currentPnl).toFixed(3))
    : null;
  const drawdownPctOfValue = (drawdownFromPeak != null && positionData.total_value_usd > 0 && peakPnl != null)
    ? Number((((peakPnl - currentPnl) / 100) * positionData.total_value_usd).toFixed(4))
    : null;

  const lifecycle = bucketLifecycle(ageMinutes ?? 0);
  const closeCostPct = positionData.total_value_usd > 0
    ? Number(((estCloseCostSol / positionData.total_value_usd) * 100).toFixed(3))
    : null;

  const metrics = {
    pnl_velocity_per_hour: pnlVelocity,
    fee_velocity_per_hour: feeVelocity,
    drawdown_from_peak_pct: drawdownFromPeak,
    drawdown_pct_of_value: drawdownPctOfValue,
    time_in_range_pct: timeInRangePct,
    minutes_held: ageMinutes,
    age_minutes: ageMinutes,
    age_hours: ageMinutes != null ? Number((ageMinutes / 60).toFixed(2)) : null,
    lifecycle,
    estimated_close_cost_pct: closeCostPct,
    estimated_close_cost_sol: estCloseCostSol,
    snapshot_count: snaps.length,
  };

  metrics.hints = buildHints(metrics, { management: config.management });
  return metrics;
}

/**
 * Evaluate a parsed instruction against current position state.
 * Returns { met: boolean, reason: string } or { met: null, reason: "unparseable" }.
 */
export function evaluateInstruction({ parsed, currentPnl, ageMinutes }) {
  if (!parsed) return { met: null, reason: "unparseable" };
  if (parsed.type === "TAKE_PROFIT") {
    if (currentPnl == null) return { met: null, reason: "pnl_unavailable" };
    const met = currentPnl >= parsed.threshold;
    return { met, reason: met ? `pnl ${currentPnl.toFixed(2)}% >= target ${parsed.threshold}%` : `pnl ${currentPnl.toFixed(2)}% < target ${parsed.threshold}%` };
  }
  if (parsed.type === "STOP_LOSS") {
    if (currentPnl == null) return { met: null, reason: "pnl_unavailable" };
    const met = currentPnl <= parsed.threshold;
    return { met, reason: met ? `pnl ${currentPnl.toFixed(2)}% <= stop ${parsed.threshold}%` : `pnl ${currentPnl.toFixed(2)}% > stop ${parsed.threshold}%` };
  }
  if (parsed.type === "TIME_LIMIT") {
    if (ageMinutes == null) return { met: null, reason: "age_unavailable" };
    const met = ageMinutes >= parsed.minutes;
    return { met, reason: met ? `age ${ageMinutes}m >= limit ${parsed.minutes}m` : `age ${ageMinutes}m < limit ${parsed.minutes}m` };
  }
  return { met: null, reason: "unknown_type" };
}
