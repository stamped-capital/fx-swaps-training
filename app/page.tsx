"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * FX Swaps Training Tool — Single-file Page (Next.js App Router)
 *
 * Key rules (updated):
 * - Objective (SOLVED): for EVERY non-USD currency, t+0 USD-equivalent must be LONG in [0 .. +5m].
 *   - (So: no shorts, and no idle long > +5m USD-equivalent)
 *
 * Constraints / generation:
 * - Blotter numbers are denominated in the CCY shown on the left (NOT USD).
 * - But SOLVED checks and swap sizing limits use USD-equivalent.
 * - For JPY/MXN/PHP: allow up to 100m USD-equivalent on generation/capping (so PHP/JPY can look “large” in local units).
 *
 * Basic game (updated):
 * - Never offer swaps < 2m USD-equivalent or > 100m USD-equivalent.
 * - “Swaps traded” counts ONLY correct executed trades (correct rejects do not count).
 * - Never suggest more than 3 incorrect swaps in a day (so the day stays solvable in a decent time).
 * - Score: correct choices / total choices.
 * - Track daily scores + daily costs vs a best-possible cost target.
 *
 * Guided game (updated):
 * - Always show exactly 4 tiles:
 *    - 1 Best: solves one exposure into [0..5m] USD-equivalent long
 *    - 1 Marginal: moves toward solution but ~50% as good
 *    - 2 Worse: make positions worse
 * - Always solvable within 15 swaps; after each execute, regenerate a fresh set of 4 tiles.
 * - Has “Undo Last Trade” button (reverts last executed trade and removes it from the log).
 * - When a swap clearly went the wrong way, prompt: “Bad Swap Execution - Trade a Reversal?” (Yes/No side-by-side).
 *   - If Yes: undo blotter impact, but keep original trade in cost tracker and add a “REVERSAL” trade entry. Does NOT refund swaps left.
 * - Scoring is the same as Basic (correct / total), where correct = Best or Marginal.
 *   - End-of-day adds: % of correct executions that were Marginal vs Best.
 * - Do not reveal Best/Marginal/Worse labels inside tiles until AFTER the tile is executed.
 *
 * UI / branding (updated):
 * - Dark navy background matching Remitly logo color (#212E61).
 * - Header text is white; add a simple Remitly “R” mark (no ®).
 * - Under-blotter rules text is white on all pages for legibility.
 * - Remove “Clear preview” from cost tracker (it did nothing).
 * - FX rates displayed as a cross-rate matrix (4dp, except MXN & PHP at 2dp).
 */

type Ccy = string;

// Alphabetical order (as requested for blotter). Removed SEK/NOK, added MXN/PHP.
const CCYS: Ccy[] = ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "MXN", "NZD", "PHP", "USD"];

const HORIZON = 15; // t+0..t+14
const MAX_DAYS = 80;

const TOL_USD_EQ = 5_000_000; // SOLVED upper bound in USD equivalent
const USD_MIN_ROW_TOTAL = 300_000_000;

const NONUSD_ROW_TOTAL_MIN = 1;
const NONUSD_ROW_TOTAL_MAX = 10_000_000;

const USD_BASE_LONG = 300_000_000;

const BASIC_MAX_STEPS = 30;
const BASIC_MIN_STEPS = 15;
// Never suggest more than 3 incorrect swaps.
const BASIC_REQUIRED_BAD = 3;

const GUIDED_MAX_STEPS = 15;

const FWD_POINTS_SPREAD_BP = 1.5; // basis points

// Remitly navy (from logo color extraction).
const REMITLY_NAVY = "#212E61";

// Simplified “static” IR assumptions (annualized).
const IR: Record<Ccy, number> = {
  AUD: 0.044,
  CAD: 0.047,
  CHF: 0.02,
  EUR: 0.035,
  GBP: 0.052,
  JPY: 0.005,
  MXN: 0.11,
  NZD: 0.05,
  PHP: 0.065,
  USD: 0.05,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}
function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function id() {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}
function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

const nfInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function formatInt(n: number) {
  return nfInt.format(Math.round(n));
}

function formatM(n: number) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const m = abs / 1_000_000;
  return `${sign}${m.toFixed(1)}m`;
}

function fmtRate(n: number, ccy: Ccy) {
  // Show MXN & PHP to 2dp; others 4dp
  const dp = ccy === "MXN" || ccy === "PHP" ? 2 : 4;
  return Number.isFinite(n) ? n.toFixed(dp) : "—";
}

function formatWithCommasDigitsOnly(raw: string) {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function parseCommaNumber(s: string) {
  const n = Number(String(s ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}

function cellClass(v: number) {
  if (v > 0) return "bg-emerald-100 text-emerald-950";
  if (v < 0) return "bg-rose-100 text-rose-950";
  return "bg-slate-50 text-slate-900";
}

/* ----------------------------- Model ----------------------------- */

type Scenario = {
  balances: Record<Ccy, number>;
  flows: Record<Ccy, number[]>;
};

function shallowCopyScenario(s: Scenario): Scenario {
  const flows: Record<Ccy, number[]> = {} as any;
  for (const c of CCYS) flows[c] = [...s.flows[c]];
  return { balances: { ...s.balances }, flows };
}

function cashflowView(s: Scenario): Record<Ccy, number[]> {
  const out: Record<Ccy, number[]> = {} as any;
  for (const c of CCYS) {
    const row = Array.from({ length: MAX_DAYS }, () => 0);
    row[0] = s.balances[c] ?? 0;
    for (let d = 1; d < MAX_DAYS; d++) row[d] = s.flows[c][d] ?? 0;
    out[c] = row;
  }
  return out;
}

function forwardFromSpot(spot: number, buyCcy: Ccy, sellCcy: Ccy, days: number) {
  const T = clamp(days, 0, 3650) / 360;
  const rb = IR[buyCcy] ?? 0.03;
  const rs = IR[sellCcy] ?? 0.03;

  const theoFwd = (spot * (1 + rs * T)) / (1 + rb * T);
  const points = theoFwd - spot;

  const spread = spot * (FWD_POINTS_SPREAD_BP / 10000);
  const widenedPoints = points === 0 ? spread : points + Math.sign(points) * spread;

  return spot + widenedPoints;
}

type SwapTrade = {
  buyCcy: Ccy;
  sellCcy: Ccy;
  notionalBuy: number; // amount of buyCcy on near leg (positive)
  nearOffset: number;
  farOffset: number;
  spot: number; // sell per buy
  fwd: number; // sell per buy
};

function applyFxSwap(s: Scenario, t: SwapTrade): Scenario {
  const out = shallowCopyScenario(s);

  const applyAt = (ccy: Ccy, offset: number, delta: number) => {
    if (offset === 0) {
      out.balances[ccy] += delta;
      return;
    }
    if (offset > 0 && offset < MAX_DAYS) out.flows[ccy][offset] += delta;
  };

  // Near
  applyAt(t.buyCcy, t.nearOffset, t.notionalBuy);
  applyAt(t.sellCcy, t.nearOffset, -Math.round(t.notionalBuy * t.spot));

  // Far
  applyAt(t.buyCcy, t.farOffset, -t.notionalBuy);
  applyAt(t.sellCcy, t.farOffset, +Math.round(t.notionalBuy * t.fwd));

  return out;
}

function invertTrade(t: SwapTrade): SwapTrade {
  // opposite direction, same tenors and amounts
  return {
    buyCcy: t.sellCcy,
    sellCcy: t.buyCcy,
    notionalBuy: Math.round(t.notionalBuy * t.spot), // approximate: buy amount in opposite direction
    nearOffset: t.nearOffset,
    farOffset: t.farOffset,
    spot: 1 / t.spot,
    fwd: 1 / t.fwd,
  };
}

function enforceRowTotals(s: Scenario): Scenario {
  const out = shallowCopyScenario(s);

  const rowTotal = (ccy: Ccy) => {
    let tot = out.balances[ccy] ?? 0;
    for (let d = 1; d < MAX_DAYS; d++) tot += out.flows[ccy][d] ?? 0;
    return tot;
  };

  for (const c of CCYS) {
    if (c === "USD") continue;

    let tot = rowTotal(c);
    const target = Math.round(rand(1_000_000, 9_000_000) / 10_000) * 10_000;
    const delta = target - tot;
    out.flows[c][MAX_DAYS - 1] = (out.flows[c][MAX_DAYS - 1] ?? 0) + delta;

    tot = rowTotal(c);
    if (!(tot > NONUSD_ROW_TOTAL_MIN && tot < NONUSD_ROW_TOTAL_MAX)) {
      const nudged = clamp(tot, 1_000, 9_999_000);
      const fix = nudged - tot;
      out.flows[c][MAX_DAYS - 1] += fix;
    }
  }

  let usdTot = rowTotal("USD");
  if (usdTot < USD_MIN_ROW_TOTAL) out.balances["USD"] += USD_MIN_ROW_TOTAL - usdTot;

  return out;
}

function rollValueDate(s: Scenario): Scenario {
  const out = shallowCopyScenario(s);

  for (const c of CCYS) {
    out.balances[c] += out.flows[c][1] ?? 0;

    for (let d = 1; d < MAX_DAYS - 1; d++) out.flows[c][d] = out.flows[c][d + 1] ?? 0;
    out.flows[c][0] = 0;

    out.flows[c][MAX_DAYS - 1] = Math.round(rand(-15_000_000, 15_000_000));
  }

  return enforceRowTotals(out);
}

/* ----------------------------- Rates ----------------------------- */

type UsdRates = {
  usdPerCcy: Record<Ccy, number>;
  ccyPerUsd: Record<Ccy, number>;
  asOf: string;
  status: "ok" | "loading" | "error";
  error?: string;
};

function makeEmptyRates(): UsdRates {
  const usdPerCcy: Record<Ccy, number> = {} as any;
  const ccyPerUsd: Record<Ccy, number> = {} as any;
  for (const c of CCYS) {
    usdPerCcy[c] = c === "USD" ? 1 : NaN;
    ccyPerUsd[c] = c === "USD" ? 1 : NaN;
  }
  return { usdPerCcy, ccyPerUsd, asOf: "", status: "loading" };
}

function spotFromUsdRates(buyCcy: Ccy, sellCcy: Ccy, rates: UsdRates) {
  // returns sell per buy
  if (buyCcy === sellCcy) return 1;
  const ub = rates.usdPerCcy[buyCcy];
  const us = rates.usdPerCcy[sellCcy];
  if (!Number.isFinite(ub) || !Number.isFinite(us)) return null;
  return ub / us;
}

function toUsd(amount: number, ccy: Ccy, rates: UsdRates) {
  const k = rates.usdPerCcy[ccy];
  if (!Number.isFinite(k)) return NaN;
  return amount * k;
}

function swapUsdCost(trade: { notionalBuy: number; spot: number; fwd: number; sellCcy: Ccy }, rates: UsdRates) {
  const diffSell = trade.notionalBuy * (trade.fwd - trade.spot);
  return toUsd(diffSell, trade.sellCcy, rates);
}

/* ----------------------------- Objective helpers (USD-equivalent) ----------------------------- */

function usdEqT0(bal: Record<Ccy, number>, rates: UsdRates): Record<Ccy, number> {
  const out: Record<Ccy, number> = {} as any;
  for (const c of CCYS) out[c] = toUsd(bal[c] ?? 0, c, rates);
  return out;
}

function solvedT0Long0to5mUsdEq(bal: Record<Ccy, number>, rates: UsdRates) {
  // Non-USD must be LONG and between 0 and +5m USD eq.
  for (const c of CCYS) {
    if (c === "USD") continue;
    const u = toUsd(bal[c] ?? 0, c, rates);
    if (!Number.isFinite(u)) return false;
    if (u < 0) return false;
    if (u > TOL_USD_EQ) return false;
  }
  return true;
}

function t0BadnessUsdEq(bal: Record<Ccy, number>, rates: UsdRates) {
  // Lower is better. Penalize shorts heavily + excess idle cash.
  let e = 0;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const u = toUsd(bal[c] ?? 0, c, rates);
    if (!Number.isFinite(u)) continue;
    if (u < 0) e += Math.abs(u) * 2;
    if (u > TOL_USD_EQ) e += u - TOL_USD_EQ;
  }
  return e;
}

/* ----------------------------- Scenario generation + capping ----------------------------- */

function generateScenarioRaw(): Scenario {
  const balances: Record<Ccy, number> = {} as any;
  const flows: Record<Ccy, number[]> = {} as any;

  for (const c of CCYS) {
    balances[c] = Math.round(rand(-80_000_000, 80_000_000));
    flows[c] = Array.from({ length: MAX_DAYS }, () => 0);
    flows[c][0] = 0;
  }

  balances["USD"] = USD_BASE_LONG + Math.round(rand(0, 80_000_000));

  for (let d = 1; d < MAX_DAYS; d++) {
    for (const c of CCYS) {
      flows[c][d] += Math.round(rand(-20_000_000, 20_000_000));
      if (Math.random() < 0.2) flows[c][d] += Math.round(rand(-80_000_000, 80_000_000));
      if (Math.random() < 0.06) flows[c][d] += Math.round(rand(-120_000_000, 120_000_000));
    }
  }

  return enforceRowTotals({ balances, flows });
}

function capScenarioToUsdEq(s: Scenario, rates: UsdRates): Scenario {
  // Cap t+0 USD-equivalent sizes so JPY/MXN/PHP can be bigger (up to 100m USD eq), others ~80m.
  const out = shallowCopyScenario(s);
  if (rates.status !== "ok") return out;

  const capUsdEqFor = (c: Ccy) => {
    if (c === "USD") return Infinity;
    return c === "JPY" || c === "MXN" || c === "PHP" ? 100_000_000 : 80_000_000;
  };

  for (const c of CCYS) {
    const cap = capUsdEqFor(c);
    const u = toUsd(out.balances[c] ?? 0, c, rates);
    if (!Number.isFinite(u) || cap === Infinity) continue;
    if (Math.abs(u) <= cap) continue;

    const scale = cap / Math.abs(u);
    out.balances[c] = Math.round((out.balances[c] ?? 0) * scale);
  }

  return out;
}

/* ----------------------------- Sizing helpers (min 2m / max 100m USD eq) ----------------------------- */

const MIN_SWAP_USD_EQ = 2_000_000;
const MAX_SWAP_USD_EQ = 100_000_000;

function clampNotionalBuyToUsdEq(t: SwapTrade, rates: UsdRates): SwapTrade | null {
  if (rates.status !== "ok") return t;

  const u = toUsd(t.notionalBuy, t.buyCcy, rates);
  if (!Number.isFinite(u) || u <= 0) return null;

  if (u < MIN_SWAP_USD_EQ) {
    const factor = MIN_SWAP_USD_EQ / u;
    const nb = Math.round(t.notionalBuy * factor);
    return { ...t, notionalBuy: nb };
  }
  if (u > MAX_SWAP_USD_EQ) {
    const factor = MAX_SWAP_USD_EQ / u;
    const nb = Math.round(t.notionalBuy * factor);
    return { ...t, notionalBuy: nb };
  }
  return t;
}

/* ----------------------------- Basic planner (pre-built solvable list) ----------------------------- */

type BasicSuggestion = SwapTrade & {
  id: string;
  isGood: boolean; // good => correct action is EXECUTE. bad => correct action is REJECT.
  usdCost: number | null;
};

function makeSwapVsUsdToTargetOneCcy(
  s: Scenario,
  rates: UsdRates,
  ccy: Ccy,
  targetUsdEq: number, // between 0..5m
  farOffset: number
): SwapTrade | null {
  if (ccy === "USD") return null;
  const curUsd = toUsd(s.balances[ccy] ?? 0, ccy, rates);
  if (!Number.isFinite(curUsd)) return null;

  const deltaUsd = targetUsdEq - curUsd; // if positive => need more long (buy ccy)
  const nearOffset = 0;
  let buyCcy: Ccy;
  let notionalBuy: number;

  if (deltaUsd >= 0) {
    buyCcy = ccy;
    const usdPer = rates.usdPerCcy[ccy];
    if (!Number.isFinite(usdPer) || usdPer <= 0) return null;
    notionalBuy = Math.round(deltaUsd / usdPer);
  } else {
    // reduce long / fix short: buy USD, sell ccy
    buyCcy = "USD";
    const wantReduceUsd = Math.abs(deltaUsd);
    notionalBuy = Math.round(wantReduceUsd); // notionalBuy in USD
  }

  const buy = buyCcy;
  const sell = buyCcy === "USD" ? ccy : "USD";
  const sp = spotFromUsdRates(buy, sell, rates);
  if (!sp) return null;
  const fw = forwardFromSpot(sp, buy, sell, Math.max(1, farOffset - nearOffset));

  const t: SwapTrade = {
    buyCcy: buy,
    sellCcy: sell,
    notionalBuy,
    nearOffset,
    farOffset,
    spot: sp,
    fwd: fw,
  };

  return clampNotionalBuyToUsdEq(t, rates);
}

function makeBadSwapDifferentPair(s: Scenario, rates: UsdRates, avoidPair: string | null): SwapTrade | null {
  const farOffset = Math.random() < 0.7 ? 2 : pickOne([3, 5, 7]);
  const nearOffset = 0;

  const allPairs: Array<[Ccy, Ccy]> = [];
  for (const a of CCYS) for (const b of CCYS) if (a !== b) allPairs.push([a, b]);

  const shuffled = [...allPairs].sort(() => Math.random() - 0.5);
  for (const [buyCcy, sellCcy] of shuffled) {
    const pairKey = `${buyCcy}/${sellCcy}`;
    if (avoidPair && pairKey === avoidPair) continue;

    const sp = spotFromUsdRates(buyCcy, sellCcy, rates) ?? 1;
    const fw = forwardFromSpot(sp, buyCcy, sellCcy, Math.max(1, farOffset - nearOffset));

    // choose notional so it's within [2m..100m] USD eq (based on buy ccy)
    const usdPer = rates.usdPerCcy[buyCcy];
    if (!Number.isFinite(usdPer) || usdPer <= 0) continue;
    const targetUsd = rand(MIN_SWAP_USD_EQ, Math.min(25_000_000, MAX_SWAP_USD_EQ));
    const notionalBuy = Math.round(targetUsd / usdPer);

    const t: SwapTrade = { buyCcy, sellCcy, notionalBuy, nearOffset, farOffset, spot: sp, fwd: fw };
    const clamped = clampNotionalBuyToUsdEq(t, rates);
    if (!clamped) continue;

    // ensure it is "bad" by checking it worsens badness
    const after = applyFxSwap(s, clamped);
    if (t0BadnessUsdEq(after.balances, rates) > t0BadnessUsdEq(s.balances, rates)) return clamped;
  }

  return null;
}

function buildBasicPlanForDay(startScenario: Scenario, rates: UsdRates): BasicSuggestion[] {
  // Plan: create a sequence that becomes SOLVED if user executes all good and rejects all bad.
  // Ensure at most BASIC_REQUIRED_BAD bad suggestions.
  const plan: BasicSuggestion[] = [];
  let s = shallowCopyScenario(startScenario);

  const farChoices = [2, 3, 5, 7];

  // 1) add up to BASIC_REQUIRED_BAD bad suggestions early
  let lastBadPair: string | null = null;
  let badCount = 0;
  for (let i = 0; i < BASIC_REQUIRED_BAD; i++) {
    const bad = makeBadSwapDifferentPair(s, rates, lastBadPair);
    if (!bad) break;
    lastBadPair = `${bad.buyCcy}/${bad.sellCcy}`;
    const usdC = swapUsdCost({ notionalBuy: bad.notionalBuy, spot: bad.spot, fwd: bad.fwd, sellCcy: bad.sellCcy }, rates);
    plan.push({ id: id(), ...bad, isGood: false, usdCost: Number.isFinite(usdC) ? usdC : null });
    badCount++;
  }

  // 2) solve each currency vs USD as needed
  const targetMid = 2_500_000;
  for (let guard = 0; guard < 200; guard++) {
    if (plan.length >= BASIC_MAX_STEPS) break;
    if (solvedT0Long0to5mUsdEq(s.balances, rates)) break;

    const nonUsd = CCYS.filter((c) => c !== "USD");
    const scores = nonUsd
      .map((c) => ({ c, u: toUsd(s.balances[c] ?? 0, c, rates) }))
      .filter((x) => Number.isFinite(x.u))
      .map((x) => {
        const u = x.u as number;
        const bad = u < 0 ? Math.abs(u) * 2 : u > TOL_USD_EQ ? u - TOL_USD_EQ : 0;
        return { c: x.c, u, bad };
      })
      .sort((a, b) => b.bad - a.bad);

    const pick = scores[0];
    if (!pick || pick.bad <= 0) break;

    const far = pickOne(farChoices);
    const t = makeSwapVsUsdToTargetOneCcy(s, rates, pick.c, clamp(targetMid, 0, TOL_USD_EQ), far);
    if (!t) break;

    // Ensure isGood (actually improves)
    const after = applyFxSwap(s, t);
    if (t0BadnessUsdEq(after.balances, rates) >= t0BadnessUsdEq(s.balances, rates)) {
      continue;
    }

    const usdC = swapUsdCost({ notionalBuy: t.notionalBuy, spot: t.spot, fwd: t.fwd, sellCcy: t.sellCcy }, rates);
    plan.push({ id: id(), ...t, isGood: true, usdCost: Number.isFinite(usdC) ? usdC : null });

    // simulate “correct” path: good trades get executed
    s = after;
  }

  // 3) pad with additional bad suggestions ONLY if we still haven't hit BASIC_MIN_STEPS and haven't hit bad cap
  // (Keeps the day moving, but never exceeds 3 bad suggestions.)
  let avoid = lastBadPair;
  while (plan.length < BASIC_MIN_STEPS && plan.length < BASIC_MAX_STEPS && badCount < BASIC_REQUIRED_BAD) {
    const bad = makeBadSwapDifferentPair(s, rates, avoid);
    if (!bad) break;
    avoid = `${bad.buyCcy}/${bad.sellCcy}`;
    const usdC = swapUsdCost({ notionalBuy: bad.notionalBuy, spot: bad.spot, fwd: bad.fwd, sellCcy: bad.sellCcy }, rates);
    plan.push({ id: id(), ...bad, isGood: false, usdCost: Number.isFinite(usdC) ? usdC : null });
    badCount++;
  }

  return plan.slice(0, BASIC_MAX_STEPS);
}

function computeBestPossibleCostBasic(plan: BasicSuggestion[]) {
  let t = 0;
  for (const x of plan) {
    if (!x.isGood) continue;
    if (Number.isFinite(x.usdCost as any)) t += x.usdCost as number;
  }
  return t;
}

/* ----------------------------- Guided (4 tiles) ----------------------------- */

type GuidedTile = SwapTrade & {
  id: string;
  category: "Best" | "Marginal" | "Worse";
  scoreDelta: 10 | 5 | -5;
  why: string;
  usdCost: number | null;
  counterAmountLabel: string; // e.g. "≈ 31.2m USD"
};

function makeGuidedTile(rates: UsdRates, t: SwapTrade, category: GuidedTile["category"], scoreDelta: GuidedTile["scoreDelta"], why: string): GuidedTile {
  const usdC = swapUsdCost({ notionalBuy: t.notionalBuy, spot: t.spot, fwd: t.fwd, sellCcy: t.sellCcy }, rates);
  const counterNear = Math.round(t.notionalBuy * t.spot); // sellCcy amount (abs) on near
  const counterLabel = `${formatM(counterNear)} ${t.sellCcy}`;
  return {
    id: id(),
    ...t,
    category,
    scoreDelta,
    why,
    usdCost: Number.isFinite(usdC) ? usdC : null,
    counterAmountLabel: counterLabel,
  };
}

function pickWorstNonUsdByUsdEq(bal: Record<Ccy, number>, rates: UsdRates) {
  let best: { c: Ccy; bad: number; u: number } | null = null;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const u = toUsd(bal[c] ?? 0, c, rates);
    if (!Number.isFinite(u)) continue;
    const bad = u < 0 ? Math.abs(u) * 2 : u > TOL_USD_EQ ? u - TOL_USD_EQ : 0;
    if (!best || bad > best.bad) best = { c, bad, u };
  }
  return best;
}

function buildGuidedFourTiles(s: Scenario, rates: UsdRates): GuidedTile[] {
  const farOffset = 2;
  const targetMid = 2_500_000;

  const worst = pickWorstNonUsdByUsdEq(s.balances, rates);
  const focus = worst?.c ?? "EUR";

  // BEST: bring focus into [0..5m] (aim ~2.5m)
  const bestTrade = makeSwapVsUsdToTargetOneCcy(s, rates, focus, clamp(targetMid, 0, TOL_USD_EQ), farOffset);

  // If for some reason we can't, fall back to a random USD pair
  const fallback = () => {
    const buyCcy = pickOne(CCYS.filter((c) => c !== "USD"));
    const sellCcy = "USD";
    const sp = spotFromUsdRates(buyCcy, sellCcy, rates) ?? 1;
    const fw = forwardFromSpot(sp, buyCcy, sellCcy, farOffset);
    const usdPer = rates.usdPerCcy[buyCcy];
    const notionalBuy = Math.round(10_000_000 / (usdPer || 1));
    return clampNotionalBuyToUsdEq({ buyCcy, sellCcy, notionalBuy, nearOffset: 0, farOffset, spot: sp, fwd: fw }, rates);
  };

  const best = bestTrade ?? fallback();
  if (!best) return [];

  // MARGINAL: ~half size in same direction
  const marginal: SwapTrade = {
    ...best,
    notionalBuy: Math.max(1, Math.round(best.notionalBuy * 0.5)),
  };
  const marginalClamped = clampNotionalBuyToUsdEq(marginal, rates) ?? marginal;

  // WORSE 1: opposite direction same pair similar size
  const worse1Base: SwapTrade = {
    ...best,
    buyCcy: best.sellCcy,
    sellCcy: best.buyCcy,
    notionalBuy: best.notionalBuy,
    spot: 1 / best.spot,
    fwd: 1 / best.fwd,
  };
  const worse1 = clampNotionalBuyToUsdEq(worse1Base, rates) ?? worse1Base;

  // WORSE 2: another bad trade (different pair) if possible
  const worse2Trade = makeBadSwapDifferentPair(s, rates, `${worse1.buyCcy}/${worse1.sellCcy}`) ?? worse1;

  const tiles: GuidedTile[] = [
    makeGuidedTile(rates, best, "Best", 10, `Best: solves ${focus} funding into the target range on t+0 (USD-equivalent).`),
    makeGuidedTile(rates, marginalClamped, "Marginal", 5, `Marginal: moves ${focus} toward target, but only ~half as effective as Best.`),
    makeGuidedTile(rates, worse1, "Worse", -5, `Worse: pushes ${focus} away from target (wrong-way direction).`),
    makeGuidedTile(rates, worse2Trade, "Worse", -5, `Worse: increases today’s funding risk versus the objective.`),
  ];

  // shuffle so Best isn't always in same position
  return tiles.sort(() => Math.random() - 0.5);
}

function computeBestPossibleCostGuided(startScenario: Scenario, rates: UsdRates) {
  // Simulate “perfect play” by always picking the Best tile at each step (up to 15 or until solved).
  let s = shallowCopyScenario(startScenario);
  let cost = 0;

  for (let step = 0; step < GUIDED_MAX_STEPS; step++) {
    if (solvedT0Long0to5mUsdEq(s.balances, rates)) break;
    const tiles = buildGuidedFourTiles(s, rates);
    const best = tiles.find((t) => t.category === "Best") ?? tiles[0];
    if (!best) break;
    if (Number.isFinite(best.usdCost as any)) cost += best.usdCost as number;
    s = applyFxSwap(s, best);
  }

  return cost;
}

/* ----------------------------- UI ----------------------------- */

type Tab = "home" | "basic" | "guided" | "manual";

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={classNames(
        "px-4 py-2 rounded-xl text-sm font-semibold border transition",
        active ? "bg-white text-slate-900 border-white" : "bg-transparent text-white border-white/30 hover:bg-white/10"
      )}
    >
      {children}
    </button>
  );
}

function Banner({ dayNumber }: { dayNumber: number }) {
  return (
    <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl shadow-sm px-5 py-4">
      <div className="flex flex-col gap-1">
        <div className="text-lg font-semibold text-slate-900">Day {dayNumber}</div>
      </div>
      <div className="text-sm text-slate-900 font-semibold">Blotter shows net cashflows by day. t+0 is cash at bank plus executed trades.</div>
    </div>
  );
}

function Blotter({
  scenario,
  highlightCells,
  prevValues,
}: {
  scenario: Scenario;
  highlightCells?: Set<string>;
  prevValues?: Record<string, number>;
}) {
  const view = useMemo(() => cashflowView(scenario), [scenario]);
  const cols = Array.from({ length: HORIZON }, (_, i) => i);

  return (
    <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-[1080px] w-full text-sm">
        <thead className="sticky top-0 bg-white z-10">
          <tr>
            <th className="text-left p-3 border-b border-slate-200 w-[90px] text-slate-900 font-semibold">CCY</th>
            {cols.map((t) => (
              <th key={t} className="text-right p-3 border-b border-slate-200 text-slate-900 font-semibold">
                t+{t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CCYS.map((ccy) => (
            <tr key={ccy} className="border-b border-slate-100 last:border-b-0">
              <td className="p-3 font-semibold text-slate-900">{ccy}</td>
              {cols.map((t) => {
                const v = view[ccy][t] ?? 0;
                const k = `${ccy}:${t}`;
                const hi = highlightCells?.has(k);
                const pv = prevValues?.[k];
                return (
                  <td
                    key={t}
                    className={classNames("p-3 text-right tabular-nums transition", cellClass(v), hi ? "ring-2 ring-yellow-400 ring-inset" : "")}
                  >
                    <div className="font-semibold">{formatM(v)}</div>
                    {hi && typeof pv === "number" ? <div className="text-[11px] font-bold text-slate-700 mt-1">prev. {formatM(pv)}</div> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pill({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3 shadow-sm">
      <div className="text-sm font-semibold text-slate-900">{label}</div>
      <div className="text-lg font-bold text-slate-900">{value}</div>
    </div>
  );
}

function InfoModal({
  open,
  title,
  message,
  onOk,
}: {
  open: boolean;
  title: string;
  message: string;
  onOk: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-lg p-5">
        <div className="text-lg font-extrabold text-slate-900">{title}</div>
        <div className="mt-2 text-sm font-semibold text-slate-700 whitespace-pre-wrap">{message}</div>
        <div className="mt-4 flex justify-end">
          <button onClick={onOk} className="px-5 py-3 rounded-2xl text-sm font-bold bg-slate-900 text-white hover:bg-slate-800 transition">
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  open,
  title,
  message,
  yesText = "Yes",
  noText = "No",
  onYes,
  onNo,
}: {
  open: boolean;
  title: string;
  message: string;
  yesText?: string;
  noText?: string;
  onYes: () => void;
  onNo: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-lg p-5">
        <div className="text-lg font-extrabold text-slate-900">{title}</div>
        <div className="mt-2 text-sm font-semibold text-slate-700 whitespace-pre-wrap">{message}</div>
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onNo} className="px-5 py-3 rounded-2xl text-sm font-bold border border-slate-200 bg-white hover:bg-slate-50 transition text-slate-900">
            {noText}
          </button>
          <button onClick={onYes} className="px-5 py-3 rounded-2xl text-sm font-bold bg-slate-900 text-white hover:bg-slate-800 transition">
            {yesText}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Page ----------------------------- */

type TradeLogItem = {
  id: string;
  label: string;
  usdCost: number | null;
  timestamp: number;
  correct?: boolean;
  mode?: "basic" | "guided" | "manual";
  tag?: "REVERSAL";
};

type BasicDecision = {
  id: string;
  action: "execute" | "reject";
  wasGood: boolean; // whether correct action would be execute
  correct: boolean; // whether user's decision matched
  executed: boolean; // whether trade actually executed
  timestamp: number;
};

type HistoryItem = {
  scenarioBefore: Scenario;
  trade: SwapTrade;
  logId: string;
  mode: "basic" | "guided" | "manual";
};

type DayResult = {
  id: string;
  dayNumber: number;
  mode: "basic" | "guided";
  scoreCorrect: number;
  scoreTotal: number;
  scoreText: string; // "x/y"
  costActual: number;
  costBest: number;
  costVariance: number; // actual - best
  note: string; // improving / harder day / etc
  guidedMarginalPct?: number | null; // percent of correct that were marginal
};

export default function Page() {
  const [tab, setTab] = useState<Tab>("home");
  const [dayNumber, setDayNumber] = useState(1);

  const [previewEnabled, setPreviewEnabled] = useState(false);

  // Rates
  const [rates, setRates] = useState<UsdRates>(() => makeEmptyRates());
  const ratesRef = useRef<UsdRates>(rates);
  useEffect(() => {
    ratesRef.current = rates;
  }, [rates]);

  useEffect(() => {
    let cancelled = false;

    async function fetchUsdRates() {
      try {
        setRates((r) => ({ ...r, status: "loading" }));
        const toList = CCYS.filter((c) => c !== "USD").join(",");
        const res = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${encodeURIComponent(toList)}`);
        if (!res.ok) throw new Error(`Rates fetch failed (${res.status})`);
        const data = await res.json();
        const fx = data?.rates;

        const ccyPerUsd: Record<Ccy, number> = {} as any;
        const usdPerCcy: Record<Ccy, number> = {} as any;

        for (const c of CCYS) {
          if (c === "USD") {
            ccyPerUsd[c] = 1;
            usdPerCcy[c] = 1;
            continue;
          }
          const v = fx?.[c];
          if (typeof v !== "number") {
            ccyPerUsd[c] = NaN;
            usdPerCcy[c] = NaN;
          } else {
            ccyPerUsd[c] = v;
            usdPerCcy[c] = 1 / v;
          }
        }

        if (cancelled) return;
        setRates({ ccyPerUsd, usdPerCcy, asOf: data?.date ?? "", status: "ok" });
      } catch (e: any) {
        if (cancelled) return;
        setRates((r) => ({ ...r, status: "error", error: e?.message ?? "Rate error" }));
      }
    }

    fetchUsdRates();
    const timer = setInterval(fetchUsdRates, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Shared scenario
  const [scenario, setScenario] = useState<Scenario>(() => generateScenarioRaw());

  // When rates become OK, cap scenario so JPY/MXN/PHP can be big (<=100m USD eq)
  useEffect(() => {
    if (rates.status !== "ok") return;
    setScenario((s) => capScenarioToUsdEq(s, rates));
  }, [rates.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trade log (actual executed swaps)
  const [tradeLog, setTradeLog] = useState<TradeLogItem[]>([]);

  // Execution history (for undo)
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const totalCost = useMemo(() => {
    let t = 0;
    for (const x of tradeLog) if (Number.isFinite(x.usdCost as any)) t += x.usdCost as number;
    return t;
  }, [tradeLog]);

  // Daily summaries (basic + guided)
  const [dayResults, setDayResults] = useState<DayResult[]>([]);
  const lastBasicScorePctRef = useRef<number | null>(null);
  const lastGuidedScorePctRef = useRef<number | null>(null);

  function logTrade(t: SwapTrade, correct?: boolean, mode?: TradeLogItem["mode"], tag?: TradeLogItem["tag"]) {
    const usdC =
      ratesRef.current.status === "ok"
        ? swapUsdCost({ notionalBuy: t.notionalBuy, spot: t.spot, fwd: t.fwd, sellCcy: t.sellCcy }, ratesRef.current)
        : NaN;

    const item: TradeLogItem = {
      id: id(),
      label: `${tag ? `${tag} · ` : ""}Buy ${t.buyCcy} / Sell ${t.sellCcy} · ${formatM(t.notionalBuy)} ${t.buyCcy}`,
      usdCost: Number.isFinite(usdC) ? usdC : null,
      timestamp: Date.now(),
      correct,
      mode,
      tag,
    };

    setTradeLog((prev) => [item, ...prev]);
    return item.id;
  }

  function pushHistory(sBefore: Scenario, t: SwapTrade, logId: string, mode: HistoryItem["mode"]) {
    setHistory((prev) => [{ scenarioBefore: sBefore, trade: t, logId, mode }, ...prev]);
  }

  function undoLastTrade(mode: HistoryItem["mode"]) {
    const h = history.find((x) => x.mode === mode);
    if (!h) return;

    // restore scenario
    setScenario(h.scenarioBefore);

    // remove from history
    setHistory((prev) => {
      const idx = prev.findIndex((x) => x === h);
      if (idx < 0) return prev;
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });

    // remove the corresponding log entry (UNDO removes it in guided/manual)
    setTradeLog((prev) => prev.filter((x) => x.id !== h.logId));

    // Also clear previews
    setPreviewScenario(null);
    setManualPreview(null);
  }

  /* ----------------------------- Day roll + modal ----------------------------- */

  const [modal, setModal] = useState<{ open: boolean; title: string; message: string; onOk: () => void }>({
    open: false,
    title: "",
    message: "",
    onOk: () => {},
  });

  function closeModal() {
    setModal((m) => ({ ...m, open: false }));
  }

  function addDayResult(r: DayResult) {
    setDayResults((prev) => [r, ...prev]);
  }

  function rollDayWithMessage(message: string) {
    setModal({
      open: true,
      title: "Value date roll",
      message,
      onOk: () => {
        closeModal();
        // roll value date + reset per-day state
        setScenario((s) => rollValueDate(s));
        setDayNumber((d) => d + 1);

        setTradeLog([]);
        setHistory([]);

        // Basic reset
        setBasicDecisions([]);
        setBasicIncorrect({ active: false });
        setBasicPlan([]);
        setBasicIndex(0);
        setBasicBestCostTarget(0);

        // Guided reset
        setGuidedStep(0);
        setGuidedTiles([]);
        setGuidedReveal(new Set());
        setGuidedSelected(null);
        setGuidedReversalPrompt(null);
        setPreviewScenario(null);
        setGuidedCorrectExec(0);
        setGuidedMarginalCorrectExec(0);
        setGuidedBestCostTarget(0);

        // Manual reset preview only
        setManualPreview(null);
      },
    });
  }

  /* ----------------------------- Basic decision scoring ----------------------------- */

  const [basicDecisions, setBasicDecisions] = useState<BasicDecision[]>([]);
  const basicScore = useMemo(() => {
    const total = basicDecisions.length;
    const correct = basicDecisions.filter((d) => d.correct).length;
    return { correct, total };
  }, [basicDecisions]);

  const swapsTradedCorrectExecuted = useMemo(
    () => basicDecisions.filter((d) => d.correct && d.executed).length,
    [basicDecisions]
  );

  // Basic state
  const [basicPlan, setBasicPlan] = useState<BasicSuggestion[]>([]);
  const [basicIndex, setBasicIndex] = useState(0);
  const [basicBestCostTarget, setBasicBestCostTarget] = useState(0);

  const basicSuggestion = useMemo(() => (basicPlan[basicIndex] ? basicPlan[basicIndex] : null), [basicPlan, basicIndex]);

  const [basicIncorrect, setBasicIncorrect] = useState<{
    active: boolean;
    lastScenarioBefore?: Scenario;
    changedCells?: Set<string>;
    prevValues?: Record<string, number>;
  }>({ active: false });

  function diffCellsAndPrev(a: Scenario, b: Scenario) {
    const va = cashflowView(a);
    const vb = cashflowView(b);
    const changed = new Set<string>();
    const prev: Record<string, number> = {};
    for (const c of CCYS) {
      for (let t = 0; t < HORIZON; t++) {
        const k = `${c}:${t}`;
        if ((va[c][t] ?? 0) !== (vb[c][t] ?? 0)) {
          changed.add(k);
          prev[k] = va[c][t] ?? 0;
        }
      }
    }
    return { changed, prev };
  }

  // Build basic plan whenever rates OK and scenario/day changes (and not in an incorrect/undo state)
  useEffect(() => {
    if (rates.status !== "ok") return;
    if (basicIncorrect.active) return;
    const plan = buildBasicPlanForDay(scenario, rates);
    setBasicPlan(plan);
    setBasicIndex(0);
    setBasicBestCostTarget(computeBestPossibleCostBasic(plan));
  }, [rates.status, dayNumber, basicIncorrect.active]); // eslint-disable-line react-hooks/exhaustive-deps

  function recordBasicDecision(action: "execute" | "reject", wasGood: boolean, correct: boolean, executed: boolean) {
    setBasicDecisions((prev) => [{ id: id(), action, wasGood, correct, executed, timestamp: Date.now() }, ...prev]);
  }

  function basicChoose(action: "execute" | "reject") {
    if (!basicSuggestion || ratesRef.current.status !== "ok") return;
    if (basicIncorrect.active) return;

    const s0 = scenario;

    // correct action: execute if isGood else reject
    const correct = action === "execute" ? basicSuggestion.isGood : !basicSuggestion.isGood;

    // If user executes, trade executes. If user rejects, trade does not execute.
    // Penalty behavior: if user is incorrect, we execute anyway (same as before), with undo & next.
    const shouldExecute = action === "execute" ? true : false;
    const willExecute = correct ? shouldExecute : true;

    recordBasicDecision(action, basicSuggestion.isGood, correct, willExecute && correct);

    if (!willExecute) {
      // correct reject on a bad suggestion => just advance
      setBasicIndex((i) => Math.min(i + 1, basicPlan.length));
      return;
    }

    // execute trade
    const afterScenario = applyFxSwap(s0, basicSuggestion);
    setScenario(afterScenario);

    const logId = logTrade(basicSuggestion, correct, "basic");
    pushHistory(s0, basicSuggestion, logId, "basic");

    if (correct) {
      setBasicIndex((i) => Math.min(i + 1, basicPlan.length));
      return;
    }

    // incorrect: show changed cells, allow undo
    const { changed, prev } = diffCellsAndPrev(s0, afterScenario);
    setBasicIncorrect({ active: true, lastScenarioBefore: s0, changedCells: changed, prevValues: prev });
  }

  function basicUndoAndNext() {
    if (!basicIncorrect.active || !basicIncorrect.lastScenarioBefore || ratesRef.current.status !== "ok") return;
    const restored = basicIncorrect.lastScenarioBefore;
    setScenario(restored);
    setBasicIncorrect({ active: false });
    setBasicIndex((i) => Math.min(i + 1, basicPlan.length)); // move on to next suggestion
  }

  function basicFinalizeDayAndRoll() {
    // compute score + cost vs target and roll
    const correct = basicScore.correct;
    const total = basicScore.total;
    const scorePct = total > 0 ? correct / total : 0;

    let note = "";
    if (dayNumber === 1 || lastBasicScorePctRef.current === null) {
      note = "Day 1 complete — keep going.";
    } else {
      note = scorePct >= (lastBasicScorePctRef.current ?? 0) ? "You’re improving — keep it up tomorrow." : "Harder day today — keep going tomorrow.";
    }
    lastBasicScorePctRef.current = scorePct;

    const best = basicBestCostTarget;
    const actual = totalCost;
    const variance = actual - best;

    addDayResult({
      id: id(),
      dayNumber,
      mode: "basic",
      scoreCorrect: correct,
      scoreTotal: total,
      scoreText: `${correct}/${total}`,
      costActual: actual,
      costBest: best,
      costVariance: variance,
      note,
      guidedMarginalPct: null,
    });

    const msg = [
      "Well done, the value date will now roll.",
      "",
      `Score: ${correct}/${total}`,
      `Cost (today): $${formatInt(actual)}`,
      `Best possible: $${formatInt(best)}`,
      `Cost variance vs best: ${variance >= 0 ? "+" : "-"}$${formatInt(Math.abs(variance))}`,
      "",
      note,
    ].join("\n");

    rollDayWithMessage(msg);
  }

  // Auto-roll when basic solved
  useEffect(() => {
    if (rates.status !== "ok") return;
    if (tab !== "basic") return;
    if (basicIncorrect.active) return;

    const solved = solvedT0Long0to5mUsdEq(scenario.balances, rates);
    if (solved) {
      basicFinalizeDayAndRoll();
    }
  }, [scenario, rates.status, tab, basicIncorrect.active]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----------------------------- Guided state ----------------------------- */

  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedTiles, setGuidedTiles] = useState<GuidedTile[]>([]);
  const [guidedReveal, setGuidedReveal] = useState<Set<string>>(new Set());
  const [guidedSelected, setGuidedSelected] = useState<GuidedTile | null>(null);
  const [previewScenario, setPreviewScenario] = useState<Scenario | null>(null);

  // guided scoring (correct/total) where correct = Best or Marginal
  const [guidedCorrectExec, setGuidedCorrectExec] = useState(0);
  const [guidedMarginalCorrectExec, setGuidedMarginalCorrectExec] = useState(0);
  const guidedScore = useMemo(() => ({ correct: guidedCorrectExec, total: guidedStep }), [guidedCorrectExec, guidedStep]);

  const [guidedBestCostTarget, setGuidedBestCostTarget] = useState(0);

  // reversal prompt
  const [guidedReversalPrompt, setGuidedReversalPrompt] = useState<{
    open: boolean;
    lastScenarioBefore: Scenario;
    lastTrade: GuidedTile;
  } | null>(null);

  const swapsLeft = GUIDED_MAX_STEPS - guidedStep;

  function refreshGuidedTiles(currentScenario: Scenario) {
    if (ratesRef.current.status !== "ok") return;
    const tiles = buildGuidedFourTiles(currentScenario, ratesRef.current);
    setGuidedTiles(tiles);
    setGuidedReveal(new Set());
    setGuidedSelected(null);
    setPreviewScenario(null);
  }

  useEffect(() => {
    if (rates.status !== "ok") return;
    refreshGuidedTiles(scenario);
    setGuidedBestCostTarget(computeBestPossibleCostGuided(scenario, rates));
  }, [rates.status, dayNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  function previewGuided(t: GuidedTile) {
    if (!previewEnabled) return;
    setPreviewScenario(applyFxSwap(scenario, t));
  }

  function executeGuided(t: GuidedTile) {
    if (ratesRef.current.status !== "ok") return;
    if (guidedStep >= GUIDED_MAX_STEPS) return;

    const before = scenario;
    const beforeBad = t0BadnessUsdEq(before.balances, ratesRef.current);
    const after = applyFxSwap(before, t);
    const afterBad = t0BadnessUsdEq(after.balances, ratesRef.current);

    setScenario(after);

    // reveal AFTER execute
    setGuidedReveal((prev) => {
      const n = new Set(prev);
      n.add(t.id);
      return n;
    });
    setGuidedSelected(t);

    // scoring: correct = Best or Marginal
    const isCorrect = t.category === "Best" || t.category === "Marginal";
    if (isCorrect) {
      setGuidedCorrectExec((x) => x + 1);
      if (t.category === "Marginal") setGuidedMarginalCorrectExec((x) => x + 1);
    }

    const logId = logTrade(t, isCorrect, "guided");
    pushHistory(before, t, logId, "guided");

    setGuidedStep((x) => x + 1);
    setPreviewScenario(null);

    // If it clearly went wrong (badness got worse), offer reversal
    if (afterBad > beforeBad) {
      setGuidedReversalPrompt({ open: true, lastScenarioBefore: before, lastTrade: t });
    }

    // Always regenerate a fresh set of 4 tiles after an execute
    refreshGuidedTiles(after);
  }

  function guidedDoReversalYes() {
    if (!guidedReversalPrompt) return;
    const { lastScenarioBefore, lastTrade } = guidedReversalPrompt;

    // Undo blotter impact
    setScenario(lastScenarioBefore);
    setPreviewScenario(null);

    // Keep cost tracker for original trade, and add reversal trade entry
    const rev = invertTrade(lastTrade);
    logTrade(rev, undefined, "guided", "REVERSAL");

    // Do NOT refund swaps left, do NOT remove original log, do NOT undo history.
    setGuidedReversalPrompt(null);

    // Refresh tiles from restored scenario
    refreshGuidedTiles(lastScenarioBefore);
  }

  function guidedDoReversalNo() {
    setGuidedReversalPrompt(null);
  }

  function guidedFinalizeDayAndRoll(finalMessagePrefix: string, solved: boolean) {
    const correct = guidedScore.correct;
    const total = guidedScore.total;
    const scorePct = total > 0 ? correct / total : 0;

    let note = "";
    if (dayNumber === 1 || lastGuidedScorePctRef.current === null) {
      note = "Day 1 complete — keep going.";
    } else {
      note = scorePct >= (lastGuidedScorePctRef.current ?? 0) ? "You’re improving — keep it up tomorrow." : "Harder day today — keep going tomorrow.";
    }
    lastGuidedScorePctRef.current = scorePct;

    const best = guidedBestCostTarget;
    const actual = totalCost;
    const variance = actual - best;

    const marginalPct = correct > 0 ? (guidedMarginalCorrectExec / correct) * 100 : 0;

    addDayResult({
      id: id(),
      dayNumber,
      mode: "guided",
      scoreCorrect: correct,
      scoreTotal: total,
      scoreText: `${correct}/${total}`,
      costActual: actual,
      costBest: best,
      costVariance: variance,
      note,
      guidedMarginalPct: Number.isFinite(marginalPct) ? marginalPct : null,
    });

    const msg = [
      finalMessagePrefix,
      "",
      `Score: ${correct}/${total}`,
      `Cost (today): $${formatInt(actual)}`,
      `Best possible: $${formatInt(best)}`,
      `Cost variance vs best: ${variance >= 0 ? "+" : "-"}$${formatInt(Math.abs(variance))}`,
      "",
      `Of your correct executions, Marginal %: ${correct > 0 ? `${marginalPct.toFixed(0)}%` : "—"}`,
      "",
      note,
    ].join("\n");

    rollDayWithMessage(msg);
  }

  // Guided end-of-day logic when swaps reach zero
  useEffect(() => {
    if (rates.status !== "ok") return;
    if (tab !== "guided") return;
    if (guidedStep < GUIDED_MAX_STEPS) return;

    const solved = solvedT0Long0to5mUsdEq(scenario.balances, rates);
    if (solved) {
      guidedFinalizeDayAndRoll("Well done, the value date will now roll.", true);
      return;
    }

    // If all non-USD are long but some > 5m -> idle cash
    const u = usdEqT0(scenario.balances, rates);
    let allLong = true;
    let anyIdle = false;
    for (const c of CCYS) {
      if (c === "USD") continue;
      if (!Number.isFinite(u[c])) continue;
      if (u[c] < 0) allLong = false;
      if (u[c] > TOL_USD_EQ) anyIdle = true;
    }
    if (allLong && anyIdle) {
      guidedFinalizeDayAndRoll("Everything got funded, but we left idle cash on the table.", false);
      return;
    }

    guidedFinalizeDayAndRoll("You ran out of time, the value date will now roll.", false);
  }, [guidedStep, scenario, rates.status, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----------------------------- Manual swap entry ----------------------------- */

  const [c1, setC1] = useState<Ccy>("EUR");
  const [c2, setC2] = useState<Ccy>("USD");
  const [nearBuysC1, setNearBuysC1] = useState(true);

  const [mNear, setMNear] = useState<number>(0);
  const [mFar, setMFar] = useState<number>(2);

  type ManualField = "nearBuy" | "nearSell" | "farBuy" | "farSell";
  const [activeField, setActiveField] = useState<ManualField>("nearBuy");

  const [nearBuyStr, setNearBuyStr] = useState<string>("25,000,000");
  const [nearSellStr, setNearSellStr] = useState<string>("");
  const [farBuyStr, setFarBuyStr] = useState<string>("");
  const [farSellStr, setFarSellStr] = useState<string>("");

  const [manualPreview, setManualPreview] = useState<Scenario | null>(null);

  useEffect(() => {
    setMFar((f) => (f <= mNear ? Math.min(14, mNear + 2) : f));
  }, [mNear]);

  function getManualBuySell(): { buyCcy: Ccy; sellCcy: Ccy } {
    return nearBuysC1 ? { buyCcy: c1, sellCcy: c2 } : { buyCcy: c2, sellCcy: c1 };
  }

  function buildTradeFromManual(): SwapTrade | null {
    if (ratesRef.current.status !== "ok") return null;
    if (c1 === c2) return null;

    const { buyCcy, sellCcy } = getManualBuySell();

    const nBuy = parseCommaNumber(nearBuyStr);
    if (!Number.isFinite(nBuy) || nBuy <= 0) return null;

    const sp = spotFromUsdRates(buyCcy, sellCcy, ratesRef.current);
    if (!sp) return null;
    const fw = forwardFromSpot(sp, buyCcy, sellCcy, Math.max(1, mFar - mNear));

    const t0: SwapTrade = {
      buyCcy,
      sellCcy,
      notionalBuy: Math.round(nBuy),
      nearOffset: mNear,
      farOffset: mFar,
      spot: sp,
      fwd: fw,
    };

    return clampNotionalBuyToUsdEq(t0, ratesRef.current);
  }

  // Update the 4 boxes when user edits any one box
  useEffect(() => {
    if (ratesRef.current.status !== "ok") return;
    if (c1 === c2) return;

    const { buyCcy, sellCcy } = getManualBuySell();

    const sp = spotFromUsdRates(buyCcy, sellCcy, ratesRef.current);
    if (!sp) return;
    const fw = forwardFromSpot(sp, buyCcy, sellCcy, Math.max(1, mFar - mNear));

    const computeFromNotionalBuy = (nBuy: number) => {
      const nearBuy = nBuy;
      const nearSell = -Math.round(nBuy * sp);
      const farBuy = -nBuy;
      const farSell = +Math.round(nBuy * fw);

      const fmtAbs = (x: number) => formatWithCommasDigitsOnly(String(Math.abs(x)));

      setNearBuyStr(fmtAbs(nearBuy) ? `${fmtAbs(nearBuy)}` : "");
      setNearSellStr(fmtAbs(nearSell) ? `-${fmtAbs(nearSell)}` : "");
      setFarSellStr(fmtAbs(farSell) ? `+${fmtAbs(farSell)}` : "");
      setFarBuyStr(fmtAbs(farBuy) ? `-${fmtAbs(farBuy)}` : "");
    };

    const inferNotionalBuy = () => {
      if (activeField === "nearBuy") {
        const nBuy = parseCommaNumber(nearBuyStr);
        if (!Number.isFinite(nBuy) || nBuy <= 0) return;
        computeFromNotionalBuy(Math.round(nBuy));
        return;
      }

      if (activeField === "nearSell") {
        const nSellAbs = parseCommaNumber(nearSellStr);
        if (!Number.isFinite(nSellAbs) || nSellAbs <= 0) return;
        const nBuy = nSellAbs / sp;
        computeFromNotionalBuy(Math.round(nBuy));
        return;
      }

      if (activeField === "farBuy") {
        const nFarBuyAbs = parseCommaNumber(farBuyStr);
        if (!Number.isFinite(nFarBuyAbs) || nFarBuyAbs <= 0) return;
        computeFromNotionalBuy(Math.round(nFarBuyAbs));
        return;
      }

      if (activeField === "farSell") {
        const nFarSellAbs = parseCommaNumber(farSellStr);
        if (!Number.isFinite(nFarSellAbs) || nFarSellAbs <= 0) return;
        const nBuy = nFarSellAbs / fw;
        computeFromNotionalBuy(Math.round(nBuy));
        return;
      }
    };

    inferNotionalBuy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c1, c2, nearBuysC1, mNear, mFar, activeField, nearBuyStr, nearSellStr, farBuyStr, farSellStr, rates.status]);

  const manualDraftCost = useMemo(() => {
    if (rates.status !== "ok") return null;
    const t = buildTradeFromManual();
    if (!t) return null;
    const usdC = swapUsdCost({ notionalBuy: t.notionalBuy, spot: t.spot, fwd: t.fwd, sellCcy: t.sellCcy }, rates);
    return Number.isFinite(usdC) ? usdC : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rates.status, c1, c2, nearBuysC1, mNear, mFar, nearBuyStr]);

  /* ----------------------------- Reset / Roll ----------------------------- */

  function resetAll() {
    const s = generateScenarioRaw();
    setScenario(ratesRef.current.status === "ok" ? capScenarioToUsdEq(s, ratesRef.current) : s);
    setDayNumber(1);

    setTradeLog([]);
    setHistory([]);

    setDayResults([]);
    lastBasicScorePctRef.current = null;
    lastGuidedScorePctRef.current = null;

    // Basic
    setBasicDecisions([]);
    setBasicIncorrect({ active: false });
    setBasicPlan([]);
    setBasicIndex(0);
    setBasicBestCostTarget(0);

    // Guided
    setGuidedStep(0);
    setGuidedTiles([]);
    setGuidedReveal(new Set());
    setGuidedSelected(null);
    setGuidedReversalPrompt(null);
    setPreviewScenario(null);
    setGuidedCorrectExec(0);
    setGuidedMarginalCorrectExec(0);
    setGuidedBestCostTarget(0);

    // Manual
    setManualPreview(null);
    setC1("EUR");
    setC2("USD");
    setNearBuysC1(true);
    setMNear(0);
    setMFar(2);
    setActiveField("nearBuy");
    setNearBuyStr("25,000,000");
  }

  function rollButtonClicked() {
    // Manual roll behavior: show messages based on state.
    if (ratesRef.current.status === "ok") {
      const solved = solvedT0Long0to5mUsdEq(scenario.balances, ratesRef.current);
      if (solved) {
        rollDayWithMessage("Well done, the value date will now roll.");
        return;
      }
      // If not all long, but also not all long (some shorts), show short message
      const u = usdEqT0(scenario.balances, ratesRef.current);
      let anyShort = false;
      let anyLong = false;
      for (const c of CCYS) {
        if (c === "USD") continue;
        const v = u[c];
        if (!Number.isFinite(v)) continue;
        if (v < 0) anyShort = true;
        if (v > 0) anyLong = true;
      }
      if (anyShort && anyLong) {
        rollDayWithMessage("We were short - Customer payments didn't go out, bad day at the office.");
        return;
      }
      rollDayWithMessage("You ran out of time, the value date will now roll.");
      return;
    }

    rollDayWithMessage("Value date will now roll.");
  }

  const displayScenario = tab === "guided" ? previewScenario ?? scenario : tab === "manual" ? manualPreview ?? scenario : scenario;

  const solvedNow = useMemo(() => (rates.status === "ok" ? solvedT0Long0to5mUsdEq(scenario.balances, rates) : false), [scenario, rates]);
  const solvedPreviewOrNow = useMemo(
    () => (rates.status === "ok" ? solvedT0Long0to5mUsdEq((previewScenario ?? scenario).balances, rates) : false),
    [scenario, previewScenario, rates]
  );

  const objectiveText = (
    <div className="space-y-1">
      <div className="text-sm font-semibold text-white">
        Objective (SOLVED): every <span className="font-extrabold">non-USD</span> <span className="font-extrabold">t+0</span> position must be{" "}
        <span className="font-extrabold">LONG</span> and within <span className="font-extrabold">$0 to $5m USD-equivalent</span>. (USD is exempt.)
      </div>
      <div className="text-sm font-semibold text-white">
        t+1..t+14 columns show <span className="font-extrabold">net cashflow</span> for that date (seeded trades + your swaps), not a predicted balance.
      </div>
    </div>
  );

  /* ----------------------------- Cost panel (adds best-possible target) ----------------------------- */

  const bestPossibleCostToday =
    tab === "basic" ? basicBestCostTarget : tab === "guided" ? guidedBestCostTarget : 0;

  const costPanel = (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
      <div className="mt-2 overflow-hidden rounded-2xl border border-slate-200">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 text-sm font-bold text-slate-900">Cost tracker</div>
        <div className="max-h-[220px] overflow-auto">
          {tradeLog.length === 0 ? (
            <div className="p-4 text-sm font-semibold text-slate-700">No trades yet today.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {tradeLog.map((t) => (
                <li key={t.id} className="p-3 flex items-center gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">{t.label}</div>
                    {typeof t.correct === "boolean" ? (
                      <div className={classNames("text-xs font-bold mt-1", t.correct ? "text-emerald-700" : "text-rose-700")}>
                        {t.correct ? "Correct" : "Incorrect"}
                      </div>
                    ) : null}
                    {t.mode ? <div className="text-[11px] font-bold text-slate-500 mt-1">{t.mode.toUpperCase()}</div> : null}
                  </div>

                  <div className="ml-auto text-xs font-extrabold text-slate-900">{t.usdCost === null ? "—" : `$${formatInt(t.usdCost)}`}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 py-3 bg-white border-t border-slate-200 space-y-1">
          <div className="flex items-center">
            <div className="text-sm font-bold text-slate-900">Running total (today)</div>
            <div className="ml-auto text-sm font-bold text-slate-900">${formatInt(totalCost)}</div>
          </div>

          {(tab === "basic" || tab === "guided") && Number.isFinite(bestPossibleCostToday as any) ? (
            <div className="flex items-center">
              <div className="text-xs font-bold text-slate-600">Best possible (today)</div>
              <div className="ml-auto text-xs font-extrabold text-slate-900">${formatInt(bestPossibleCostToday)}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  /* ----------------------------- Day results panel ----------------------------- */

 // --- replace the whole "const dayResultsPanel = ( ... );" block with this ---
const dayResultsPanel = (
  <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="px-4 py-3 bg-slate-50 border-b text-sm font-bold">
        Day results
      </div>

      <div className="p-4">
        {Array.isArray(dayResults) && dayResults.length > 0 ? (
          <div className="max-h-[260px] overflow-auto">
            <ul className="divide-y divide-slate-100">
              {dayResults.map((r) => (
                <li key={r.id} className="p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-extrabold text-slate-900">
                        Day {r.dayNumber} · {String(r.mode).toUpperCase()}
                      </div>
                      <div className="text-xs font-bold text-slate-600 mt-1">
                        {r.note}
                      </div>

                      {r.mode === "guided" ? (
                        <div className="text-xs font-bold text-slate-600 mt-1">
                          Marginal % of correct:{" "}
                          {typeof r.guidedMarginalPct === "number"
                            ? `${r.guidedMarginalPct}%`
                            : String(r.guidedMarginalPct ?? "")}
                        </div>
                      ) : null}
                    </div>

                    <div className="ml-auto text-right">
                      <div className="text-sm font-extrabold text-slate-900">
                         {r.scoreText ?? `${r.scoreCorrect}/${r.scoreTotal}`}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="p-4 text-sm font-semibold text-slate-700">
            No completed days yet.
          </div>
        )}
      </div>
    </div>
  </div>
);
  // end of component — make sure the function is closed
}

