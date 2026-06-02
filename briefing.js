import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
const POOL_MEMORY_FILE = "./pool-memory.json";
const SENTINEL_STATE_FILE = "./sentinel-state.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
  const poolMemory = loadJson(POOL_MEMORY_FILE) || {};
  const sentinelState = loadJson(SENTINEL_STATE_FILE) || {};

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (24h + 7d windows)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const perfLast7d = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last7d);
  const totalPnLUsd24h = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd24h = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);
  const totalPnLUsd7d = perfLast7d.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd7d = perfLast7d.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. By reason breakdown (24h)
  const reasonCounts = {};
  for (const p of perfLast24h) {
    const r = String(p.close_reason || "unknown").toLowerCase();
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }
  const reasonBreakdown = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([r, n]) => `${r}=${n}`)
    .join(", ") || "—";

  // 4. Sentinel reward (last 24h, 7d)
  const reward24h = (sentinelState.rewardHistory || []).filter(r => new Date(r.timestamp) > last24h);
  const reward7d = (sentinelState.rewardHistory || []).filter(r => new Date(r.timestamp) > last7d);
  const avgReward24h = reward24h.length > 0 ? reward24h.reduce((s, r) => s + r.reward, 0) / reward24h.length : null;
  const avgReward7d = reward7d.length > 0 ? reward7d.reduce((s, r) => s + r.reward, 0) / reward7d.length : null;

  // 5. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 6. Pool cooldowns active
  const activeCooldowns = Object.entries(poolMemory)
    .filter(([, entry]) => entry?.cooldown_until && new Date(entry.cooldown_until) > now)
    .map(([, entry]) => entry.name?.slice(0, 16) || entry.cooldown_until?.slice(0, 10))
    .slice(0, 5);

  // 7. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 8. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    `🎯 Close reasons: ${reasonBreakdown}`,
    "",
    `<b>Performance (24h):</b>`,
    `💰 Net PnL: ${totalPnLUsd24h >= 0 ? "+" : ""}$${totalPnLUsd24h.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd24h.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    avgReward24h != null
      ? `🎯 Sentinel avg reward (24h): ${avgReward24h >= 0 ? "+" : ""}${avgReward24h.toFixed(4)} (${reward24h.length} samples)`
      : "🎯 Sentinel avg reward (24h): N/A",
    "",
    `<b>Performance (7d):</b>`,
    `💰 Net PnL: ${totalPnLUsd7d >= 0 ? "+" : ""}$${totalPnLUsd7d.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd7d.toFixed(2)}`,
    perfLast7d.length > 0
      ? `📈 Win Rate (7d): ${Math.round((perfLast7d.filter(p => p.pnl_usd > 0).length / perfLast7d.length) * 100)}%`
      : "📈 Win Rate (7d): N/A",
    avgReward7d != null
      ? `🎯 Sentinel avg reward (7d): ${avgReward7d >= 0 ? "+" : ""}${avgReward7d.toFixed(4)} (${reward7d.length} samples)`
      : "",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.slice(0, 5).map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    activeCooldowns.length > 0
      ? `⏳ Active cooldowns: ${activeCooldowns.join(", ")}`
      : "",
    "────────────────"
  ];

  return lines.filter(Boolean).join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
