/**
 * DLMM Sentinel — Impermanent Loss Mitigation Skill
 *
 * Implements the 4-module architecture from the DLMM Sentinel specification:
 *   1. SENSING      — gather state (active bin, price, PnL, volatility)
 *   2. ANTICIPATION — classify market regime, estimate P_exit (bin-exit prob)
 *   3. MITIGATION   — recommend shape shift, rebalance, hedge, or emergency exit
 *   4. LEARNING     — calculate reward signal R_t, retain to Hindsight
 *
 * Reward function:
 *   R_t = α·F_t − β·ΔIL_t − γ·C_t − λ·P_t
 *
 * Market regimes (with shape mapping):
 *   LOW_VOL_SIDEWAYS    → Bid-Ask  (concentrate around active bin, harvest fees)
 *   HIGH_VOL_TRENDING   → Curve    (widen distribution, slow IL)
 *   MEAN_REVERTING      → Spot     (asymmetric ladder — take-profit or buy dip)
 *   EMERGENCY           → withdraw (full exit to stable)
 *
 * All hyperparameters live in config.sentinel.{weights, thresholds, control}.
 * Tunable at runtime via the sentinel_set_weights / sentinel_set_thresholds tools.
 */

import fs from "fs";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getPositionPnl, getActiveBin } from "./dlmm.js";
import {
  isAvailable as hindsightAvailable,
  retainPoolFact as hindsightRetainFact,
} from "../hindsight.js";

const STATE_FILE = "./sentinel-state.json";
const MAX_EVAL_HISTORY = 200;
const MAX_REWARD_HISTORY = 50;

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { evaluations: [], rewardHistory: [], regimeHistory: [], lastUpdated: null };
  }
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { evaluations: [], rewardHistory: [], regimeHistory: [], lastUpdated: null }; }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    log("sentinel_warn", `Failed to persist state: ${error.message}`);
  }
}

// ─── Module 2 helpers: ANTICIPATION ──────────────────────────────

/**
 * Classify market regime from observable signals.
 *
 * @param {number} volatility             current volatility (positive)
 * @param {number} trend                  recent price trend, normalized (-1..1)
 * @param {number} [meanReversion=0]      0..1, how strongly price is reverting
 * @returns {"LOW_VOL_SIDEWAYS"|"HIGH_VOL_TRENDING"|"MEAN_REVERTING"}
 */
export function classifyRegime(volatility, trend, meanReversion = 0) {
  const t = config.sentinel?.thresholds || {};
  const volHigh   = Number.isFinite(volatility) && volatility >= (t.volHighThreshold ?? 3.5);
  const trendStr  = Math.abs(trend || 0) >= (t.trendStrongThreshold ?? 0.4);
  const reverting = meanReversion >= (t.meanReversionThreshold ?? 0.6);

  if (reverting) return "MEAN_REVERTING";
  if (volHigh && trendStr) return "HIGH_VOL_TRENDING";
  if (!volHigh && !trendStr) return "LOW_VOL_SIDEWAYS";
  return "HIGH_VOL_TRENDING"; // conservative default
}

/**
 * Estimate P_exit: probability the price moves outside the position's
 * bin range within a short time window Δt.
 *
 * Uses a normal-distribution model: P(|z| > minDist / sigma) where
 * sigmaBins is derived from price volatility and bin_step.
 */
export function calculateBinExitProbability({
  activeBinId,
  lowerBinId,
  upperBinId,
  volatility,
  dtMin = 5,
  binStep = 100,
}) {
  if (!Number.isFinite(volatility) || volatility <= 0) return 0.5;
  if (activeBinId == null || lowerBinId == null || upperBinId == null) return 0.5;
  if (activeBinId < lowerBinId || activeBinId > upperBinId) return 1.0;

  // Map price-relative volatility to bin-space (rough): 1% price move ≈
  // (10000 / binStep) bins. Scale σ by sqrt(time).
  const sigmaBins = Math.max(0.5, (volatility * 10000) / Math.max(binStep, 1));
  const dtScale = Math.sqrt(Math.max(dtMin, 1) / 5);
  const sigmaScaled = sigmaBins * dtScale;

  const distBelow = activeBinId - lowerBinId;
  const distAbove = upperBinId - activeBinId;
  const minDist = Math.min(distBelow, distAbove);
  if (minDist <= 0) return 1.0;

  const z = minDist / sigmaScaled;
  const pExit = 2 * (1 - normalCdf(z));
  return Math.max(0, Math.min(1, pExit));
}

/** Standard AMM impermanent loss for a given price ratio. */
export function calculateIL(priceRatio) {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 0;
  return 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
}

function normalCdf(z) {
  // Abramowitz & Stegun 7.1.26 approximation
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1.0 + sign * y);
}

// ─── Module 3 helpers: MITIGATION ────────────────────────────────

const REGIME_SHAPE_MAP = {
  LOW_VOL_SIDEWAYS:   { shape: "bid_ask", description: "Concentrate tightly around active bin to harvest dynamic fees" },
  HIGH_VOL_TRENDING: { shape: "curve",   description: "Spread liquidity horizontally to widen tolerance, slow IL" },
  MEAN_REVERTING:     { shape: "spot",    description: "Asymmetric spot — laddered take-profit or buy-the-dip" },
};

export function recommendAction({ regime, pExit, ilPct, position }) {
  const t = config.sentinel?.thresholds || {};
  const control = config.sentinel?.control || {};
  const lowP = t.pExitLow ?? 0.15;
  const highP = t.pExitHigh ?? 0.60;
  const ilHedge = t.ilPctHedge ?? 2.0;
  const ilEmergency = t.ilPctEmergency ?? 15.0;
  const cooldownSec = control.rebalanceCooldownSec ?? 300;

  // 1. Emergency override — only fires on truly catastrophic IL.
  if (Number.isFinite(ilPct) && Math.abs(ilPct) >= ilEmergency) {
    return {
      action: "EMERGENCY_WITHDRAW",
      reason: `|IL|=${Math.abs(ilPct).toFixed(2)}% ≥ emergency threshold ${ilEmergency}%`,
      targetShape: "withdraw",
      cooldownOk: true,
    };
  }

  // 2. Cooldown gate — prevents rebalance thrash from noise.
  const lastEval = position?.last_sentinel_eval;
  const cooldownOk = !lastEval || (Date.now() - new Date(lastEval).getTime()) / 1000 >= cooldownSec;
  if (!cooldownOk) {
    return {
      action: "HOLD",
      reason: `Rebalance cooldown active (${cooldownSec}s). Last eval: ${lastEval}`,
      targetShape: position?.strategy || "spot",
      cooldownOk: false,
    };
  }

  // 3. Hedging — suggest delta-neutral hedge if IL is large but not catastrophic.
  if (Number.isFinite(ilPct) && Math.abs(ilPct) >= ilHedge) {
    return {
      action: "HEDGE_DELTA",
      reason: `|IL|=${Math.abs(ilPct).toFixed(2)}% ≥ hedging threshold ${ilHedge}% — recommend perp short`,
      targetShape: REGIME_SHAPE_MAP[regime]?.shape || "spot",
      hedgeSizePct: control.hedgingSizePct ?? 0.5,
      cooldownOk: true,
    };
  }

  // 4. Regime-driven shape selection.
  if (pExit > highP || regime === "HIGH_VOL_TRENDING") {
    return {
      action: "REBALANCE_SHAPE",
      reason: `Regime=${regime}, P_exit=${(pExit * 100).toFixed(1)}% > ${(highP * 100).toFixed(0)}% — widen distribution`,
      targetShape: REGIME_SHAPE_MAP.HIGH_VOL_TRENDING.shape,
      targetBins: { strategy: "wider", factor: 1.5 },
      cooldownOk: true,
    };
  }
  if (pExit < lowP && regime === "LOW_VOL_SIDEWAYS") {
    return {
      action: "TIGHTEN_SHAPE",
      reason: `Regime=LOW_VOL_SIDEWAYS, P_exit=${(pExit * 100).toFixed(1)}% < ${(lowP * 100).toFixed(0)}% — concentrate`,
      targetShape: REGIME_SHAPE_MAP.LOW_VOL_SIDEWAYS.shape,
      targetBins: { strategy: "tighter", factor: 0.7 },
      cooldownOk: true,
    };
  }
  if (regime === "MEAN_REVERTING") {
    return {
      action: "ASYMMETRIC_LADDER",
      reason: `Regime=MEAN_REVERTING — asymmetric spot ladder`,
      targetShape: REGIME_SHAPE_MAP.MEAN_REVERTING.shape,
      targetBins: { strategy: "asymmetric", ratio: 0.7 },
      cooldownOk: true,
    };
  }
  return {
    action: "HOLD",
    reason: `No action — regime=${regime}, P_exit=${(pExit * 100).toFixed(1)}%, IL=${Number.isFinite(ilPct) ? ilPct.toFixed(2) + "%" : "n/a"}`,
    targetShape: position?.strategy || "spot",
    cooldownOk: true,
  };
}

// ─── Module 4 helpers: LEARNING ──────────────────────────────────

/**
 * Calculate reward signal R_t = α·F − β·ΔIL − γ·C − λ·P
 *
 * @param {Object} params
 * @param {number} params.fees         fees earned in this interval (USD or SOL)
 * @param {number} params.deltaIL      change in IL (signed; +ve = worse)
 * @param {number} params.gasCost       gas + slippage (USD or SOL)
 * @param {number} params.oorPenalty    0 or 1 — was position OOR?
 * @param {Object} [params.weights]     override α,β,γ,λ
 */
export function calculateReward({ fees = 0, deltaIL = 0, gasCost = 0, oorPenalty = 0, weights = null } = {}) {
  const w = weights || config.sentinel?.weights || { alpha: 1.0, beta: 2.0, gamma: 0.5, lambda: 1.0 };
  const a = Number(w.alpha ?? 1.0);
  const b = Number(w.beta ?? 2.0);
  const g = Number(w.gamma ?? 0.5);
  const l = Number(w.lambda ?? 1.0);
  const reward = a * Number(fees) - b * Math.abs(Number(deltaIL)) - g * Number(gasCost) - l * Number(oorPenalty);
  return {
    reward: Number(reward.toFixed(6)),
    components: { alpha: a, beta: b, gamma: g, lambda: l },
    inputs: { fees, deltaIL, gasCost, oorPenalty },
  };
}

export function recordEvaluation(evaluation) {
  const state = load();
  state.evaluations.push({ ...evaluation, recorded_at: new Date().toISOString() });
  if (state.evaluations.length > MAX_EVAL_HISTORY) state.evaluations = state.evaluations.slice(-MAX_EVAL_HISTORY);
  if (evaluation.regime) {
    state.regimeHistory.push({ regime: evaluation.regime, ts: new Date().toISOString() });
    if (state.regimeHistory.length > MAX_REWARD_HISTORY) state.regimeHistory = state.regimeHistory.slice(-MAX_REWARD_HISTORY);
  }
  if (evaluation.reward != null) {
    state.rewardHistory.push({
      reward: evaluation.reward,
      timestamp: new Date().toISOString(),
      position: evaluation.position_address,
      regime: evaluation.regime,
      action: evaluation.recommendation,
    });
    if (state.rewardHistory.length > MAX_REWARD_HISTORY) state.rewardHistory = state.rewardHistory.slice(-MAX_REWARD_HISTORY);
  }
  save(state);

  // Hindsight: retain the evaluation as a fact for future recall. Fail-safe.
  if (hindsightAvailable()) {
    void hindsightRetainFact(
      evaluation.pool_address || "global",
      [
        `Sentinel eval @ ${new Date().toISOString()}`,
        `Regime: ${evaluation.regime}`,
        `P_exit: ${evaluation.pExit?.toFixed(3)}, IL: ${evaluation.ilPct?.toFixed(2)}%`,
        `Action: ${evaluation.recommendation} → ${evaluation.target_shape}`,
        `Reward: ${evaluation.reward?.toFixed(4)}`,
      ].join("\n"),
      {
        context: `sentinel_eval:${evaluation.regime}`,
        timestamp: new Date().toISOString(),
        metadata: {
          type: "sentinel_evaluation",
          regime: evaluation.regime,
          action: evaluation.recommendation,
          reward: String(evaluation.reward ?? ""),
        },
      },
    );
  }
}

export function getRewardHistory({ limit = 20 } = {}) {
  const state = load();
  return {
    count: state.rewardHistory.length,
    avg_reward: state.rewardHistory.length
      ? Number((state.rewardHistory.reduce((s, r) => s + r.reward, 0) / state.rewardHistory.length).toFixed(4))
      : null,
    history: state.rewardHistory.slice(-limit),
  };
}

export function getSentinelStatus() {
  return {
    weights: config.sentinel?.weights || {},
    thresholds: config.sentinel?.thresholds || {},
    control: config.sentinel?.control || {},
    rewardHistory: getRewardHistory({ limit: 10 }),
  };
}

export function setSentinelWeights(weights) {
  if (!weights || typeof weights !== "object") return { error: "weights object required" };
  const cfg = config.sentinel || (config.sentinel = {});
  cfg.weights = { ...(cfg.weights || {}), ...weights };
  return { updated: cfg.weights };
}

export function setSentinelThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== "object") return { error: "thresholds object required" };
  const cfg = config.sentinel || (config.sentinel = {});
  cfg.thresholds = { ...(cfg.thresholds || {}), ...thresholds };
  return { updated: cfg.thresholds };
}

// ─── Full evaluation pipeline (entry point for the LLM) ──────────

/**
 * Run a full Sentinel evaluation on a single position.
 * Returns regime + P_exit + IL + reward + recommendation in one call.
 *
 * @param {Object} params
 * @param {Object} params.position       position descriptor (address, pool, bin range, strategy, etc.)
 * @param {number} [params.volatility]   current volatility
 * @param {number} [params.trend]        recent price trend, -1..1
 * @param {number} [params.meanReversion] 0..1, mean-reversion strength
 * @param {number} [params.fees]         fees earned in this interval
 * @param {number} [params.gasCost]      gas + slippage in this interval
 * @param {number} [params.oorPenalty]   0 or 1, was position OOR?
 */
export async function runSentinelEvaluation({
  position,
  volatility = null,
  trend = 0,
  meanReversion = 0,
  fees = 0,
  gasCost = 0,
  oorPenalty = 0,
}) {
  let active = null;
  let livePnl = null;
  if (position?.pool_address) {
    try {
      [active, livePnl] = await Promise.all([
        getActiveBin({ pool_address: position.pool_address }),
        position.position_address
          ? getPositionPnl({ pool_address: position.pool_address, position_address: position.position_address })
          : Promise.resolve(null),
      ]);
    } catch (error) {
      log("sentinel_warn", `Failed to fetch on-chain state: ${error.message}`);
    }
  }

  // IL approximation: price drift since deploy vs. active bin price.
  const ilPct = position?.initial_price && active?.price
    ? Number((calculateIL(active.price / position.initial_price) * 100).toFixed(4))
    : null;

  // Bin range — accept several input shapes.
  const lowerBinId = position?.lower_bin_id ?? position?.bin_range?.lowerBinId ?? position?.range?.lowerBinId;
  const upperBinId = position?.upper_bin_id ?? position?.bin_range?.upperBinId ?? position?.range?.upperBinId;
  const activeBinId = active?.active_id ?? active?.bin_id ?? position?.active_bin_id;

  const pExit = (lowerBinId != null && upperBinId != null && activeBinId != null)
    ? calculateBinExitProbability({
      activeBinId,
      lowerBinId,
      upperBinId,
      volatility: Number.isFinite(volatility) ? volatility : 1.0,
      binStep: position?.bin_step ?? 100,
    })
    : null;

  const regime = classifyRegime(
    Number.isFinite(volatility) ? volatility : 1.0,
    trend,
    meanReversion,
  );

  const recommendation = recommendAction({
    regime,
    pExit: pExit ?? 0.5,
    ilPct,
    position,
  });

  const rewardResult = calculateReward({ fees, deltaIL: ilPct || 0, gasCost, oorPenalty });

  const evaluation = {
    position_address: position?.position_address || position?.publicKey || null,
    pool_address: position?.pool_address || null,
    regime,
    pExit,
    ilPct,
    volatility,
    trend,
    meanReversion,
    recommendation: recommendation.action,
    target_shape: recommendation.targetShape,
    reward: rewardResult.reward,
  };
  recordEvaluation(evaluation);

  return {
    position: position?.position_address || null,
    pool: position?.pool_address || null,
    regime,
    pExit,
    ilPct,
    active_bin: active,
    live_pnl: livePnl,
    reward: rewardResult,
    recommendation,
  };
}

/**
 * Evaluate the reward for a closed position (post-mortem). Called from
 * lessons.js when a position closes, so the Sentinel learns from outcome.
 */
export function evaluateClosedPosition({ fees, deltaIL, gasCost, oorPenalty, weights = null }) {
  const result = calculateReward({ fees, deltaIL, gasCost, oorPenalty, weights });
  recordEvaluation({
    pool_address: null,
    position_address: null,
    regime: "CLOSED",
    pExit: null,
    ilPct: deltaIL,
    recommendation: "POST_MORTEM",
    target_shape: null,
    reward: result.reward,
  });
  return result;
}
