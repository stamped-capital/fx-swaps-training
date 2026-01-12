"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * FX Swaps Training Tool — Single-file Page (Next.js App Router)
 *
 * CHANGES (per request):
 * - Removed entire Home “Ask a question about forwards/swaps” section (and OpenAI key logic).
 * - Scenario generation: MXN/PHP/JPY can be large in native terms, but capped at ~100m USD-equivalent.
 * - Objective checks now use USD-equivalent for non-USD: within ±5m USD equiv (USD exempt).
 * - Basic: now runs as a “day game” with 15–30 suggestions, at least 4 “incorrect-to-execute” (i.e., Reject is correct).
 *   - No suggested trade > 100m USD-equivalent.
 *   - Always solvable within 30 suggestions (auto-plan regenerates each day).
 *   - If a bad suggestion is offered, the next suggestion uses a different currency pair.
 *   - When solved: modal “Well Done, the value date will now roll” -> OK -> rolls to next day and restarts.
 * - Guided:
 *   - 15 swaps per day.
 *   - Tile notional shows both currencies (buy amount + counter amount).
 *   - “Undo Last Trade” button (reverts last executed guided trade).
 *   - If a chosen tile worsens t+0 objective: prompt “This went the wrong way, execute a reversal?” Yes/No
 *     - Yes: reverts blotter, keeps the original cost entry, and logs a second “REVERSAL” trade; does NOT reduce swaps left further.
 * - Roll button label everywhere: “Roll Value Date”.
 * - Roll messages:
 *   - Basic auto-roll on solve (as above).
 *   - Guided rolls when swaps hit 0 with outcome messages:
 *     - Solved => “Well done, the value date will now roll”
 *     - All funded (all non-USD t+0 are long, but some > +5m USD equiv) => “Everything got funded, but we left idle cash on the table”
 *     - Else => “You ran out of time, the value date will now roll”
 *   - Manual roll uses same messages EXCEPT:
 *     - If out of range AND not all long => “We were short - Customer payments didn't go out, bad day at the office”
 * - Styling:
 *   - Page background set to Remitly-like navy.
 *   - Header text made white and added a simple inline “logo mark” before “Remitly Treasury”.
 */

/* ----------------------------- CCYs (alphabetical) ----------------------------- */

type Ccy = string;
// Alphabetical order (as requested for blotter). Removed SEK/NOK, added MXN/PHP.
const CCYS: Ccy[] = ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "MXN", "NZD", "PHP", "USD"];

const HORIZON = 15; // t+0..t+14
const MAX_DAYS = 80;

const URGENT = 50_000_000;

// Objective tolerance is USD-equivalent for non-USD
const TOL_USD = 5_000_000;

const USD_MIN_ROW_TOTAL = 300_000_000;
const NONUSD_ROW_TOTAL_MIN = 1;
const NONUSD_ROW_TOTAL_MAX = 10_000_000;

const USD_BASE_LONG = 300_000_000;

// Guided
const GUIDED_STEPS_PER_DAY = 15;

// Basic
const BASIC_MIN_SUGGESTIONS = 15;
const BASIC_MAX_SUGGESTIONS = 30;
const BASIC_MIN_BAD_SUGGESTIONS = 4;

// Hard cap: no suggested trade > 100m USD-equivalent (near-leg USD value)
const MAX_TRADE_USD_EQ = 100_000_000;

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

// Used ONLY for scenario generation caps before live rates load
// (Approx USD per 1 unit of CCY)
const APPROX_USD_PER_CCY: Record<Ccy, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CHF: 1.12,
  CAD: 0.74,
  AUD: 0.66,
  NZD: 0.61,
  JPY: 0.0067,
  MXN: 0.058,
  PHP: 0.018,
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
function fmt4(n: number) {
  return Number.isFinite(n) ? n.toFixed(4) : "—";
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
  const urgent = Math.abs(v) >= URGENT;
  if (v > 0) return urgent ? "bg-emerald-300 text-emerald-950" : "bg-emerald-100 text-emerald-950";
  if (v < 0) return urgent ? "bg-rose-300 text-rose-950" : "bg-rose-100 text-rose-950";
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

// Forward points spread: 1.5bp applied to the forward points (widened against user).
const FWD_POINTS_SPREAD_BP = 1.5; // basis points
function forwardFromSpot(spot: number, buyCcy: Ccy, sellCcy: Ccy, days: number) {
  const T = clamp(days, 0, 3650) / 360;
  const rb = IR[buyCcy] ?? 0.03;
  const rs = IR[sellCcy] ?? 0.03;

  const theoFwd = (spot * (1 + rs * T)) / (1 + rb * T);
  const points = theoFwd - spot;

  // Spread in “rate” terms (bps of spot). Apply in the direction that makes points less favourable.
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

    // Keep day-to-day randomness, but allow big native for JPY/MXN/PHP within ~100m USD-equivalent
    const usdPer = APPROX_USD_PER_CCY[c] ?? 1;
    const maxNative = c === "JPY" || c === "MXN" || c === "PHP" ? Math.max(15_000_000, Math.round(MAX_TRADE_USD_EQ / usdPer)) : 15_000_000;
    out.flows[c][MAX_DAYS - 1] = Math.round(rand(-maxNative, maxNative));
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

/* ----------------------------- Objective helpers (USD equiv) ----------------------------- */

function nonUsdSquaredAtT0UsdEq(bal: Record<Ccy, number>, rates: UsdRates) {
  if (rates.status !== "ok") return false;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const usdEq = toUsd(bal[c] ?? 0, c, rates);
    if (!Number.isFinite(usdEq)) return false;
    if (Math.abs(usdEq) > TOL_USD) return false;
  }
  return true;
}

function allNonUsdLongButSomeIdle(bal: Record<Ccy, number>, rates: UsdRates) {
  if (rates.status !== "ok") return false;
  let anyIdle = false;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const usdEq = toUsd(bal[c] ?? 0, c, rates);
    if (!Number.isFinite(usdEq)) return false;
    if (usdEq < -TOL_USD) return false; // short
    if (usdEq > TOL_USD) anyIdle = true; // long beyond range
  }
  return anyIdle; // all non-USD are not short, and at least one too long
}

function t0ErrorUsdL1(bal: Record<Ccy, number>, rates: UsdRates) {
  if (rates.status !== "ok") return Number.POSITIVE_INFINITY;
  let e = 0;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const usdEq = toUsd(bal[c] ?? 0, c, rates);
    if (!Number.isFinite(usdEq)) return Number.POSITIVE_INFINITY;
    const v = Math.abs(usdEq);
    if (v > TOL_USD) e += v - TOL_USD;
  }
  return e;
}

/* ----------------------------- Scenario generation ----------------------------- */

function maxNativeForUsdCap(ccy: Ccy, usdCap: number) {
  const usdPer = APPROX_USD_PER_CCY[ccy] ?? 1;
  if (!Number.isFinite(usdPer) || usdPer <= 0) return usdCap;
  return Math.round(usdCap / usdPer);
}

function generateGuidedSolvableScenario(): Scenario {
  const balances: Record<Ccy, number> = {} as any;
  const flows: Record<Ccy, number[]> = {} as any;

  for (const c of CCYS) {
    // Default range is “native” and can be large for JPY/MXN/PHP (<=100m USD-equiv)
    const maxNative = c === "JPY" || c === "MXN" || c === "PHP" ? maxNativeForUsdCap(c, 100_000_000) : 80_000_000;
    balances[c] = Math.round(rand(-maxNative, maxNative));
    flows[c] = Array.from({ length: MAX_DAYS }, () => 0);
    flows[c][0] = 0;
  }

  balances["USD"] = USD_BASE_LONG + Math.round(rand(0, 80_000_000));

  for (let d = 1; d < MAX_DAYS; d++) {
    for (const c of CCYS) {
      const maxNative = c === "JPY" || c === "MXN" || c === "PHP" ? maxNativeForUsdCap(c, 35_000_000) : 20_000_000;
      flows[c][d] += Math.round(rand(-maxNative, maxNative));
      if (Math.random() < 0.2) {
        const bump = c === "JPY" || c === "MXN" || c === "PHP" ? maxNativeForUsdCap(c, 80_000_000) : 80_000_000;
        flows[c][d] += Math.round(rand(-bump, bump));
      }
      if (Math.random() < 0.06) {
        const bump = c === "JPY" || c === "MXN" || c === "PHP" ? maxNativeForUsdCap(c, 100_000_000) : 120_000_000;
        flows[c][d] += Math.round(rand(-bump, bump));
      }
    }
  }

  const nonUsd = CCYS.filter((c) => c !== "USD");
  const offCount = Math.floor(rand(6, 9));
  const off = [...nonUsd].sort(() => Math.random() - 0.5).slice(0, offCount);
  const nearZero = nonUsd.filter((c) => !off.includes(c));

  for (const c of nearZero) {
    const maxNative = maxNativeForUsdCap(c, 5_000_000); // keep near-zero within ~5m USD eq range
    balances[c] = Math.round(rand(-maxNative, maxNative));
  }
  for (const c of off) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const maxNative = maxNativeForUsdCap(c, 100_000_000);
    const mag = Math.round(rand(maxNativeForUsdCap(c, 20_000_000), maxNative) / 1_000_000) * 1_000_000;
    balances[c] = sign * mag;
  }

  return enforceRowTotals({ balances, flows });
}

/* ----------------------------- Guided ----------------------------- */

type GuidedTile = SwapTrade & {
  id: string;
  category: "Best" | "Marginal" | "Worse";
  scoreDelta: number;
  why: string;
  usdCost: number | null;
};

function pickWorstNonUsdByUsdEq(bal: Record<Ccy, number>, rates: UsdRates) {
  let worstCcy: Ccy | null = null;
  let worstAbs = -1;
  let value = 0;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const usdEq = toUsd(bal[c] ?? 0, c, rates);
    if (!Number.isFinite(usdEq)) continue;
    const a = Math.abs(usdEq);
    if (a > worstAbs) {
      worstAbs = a;
      worstCcy = c;
      value = bal[c] ?? 0;
    }
  }
  return { ccy: worstCcy, value };
}

function capTradeToUsd(t: SwapTrade, rates: UsdRates): SwapTrade {
  // Cap near-leg USD-equivalent based on buy-ccy notional (buy amount in buyCcy -> USD)
  const usdEq = Math.abs(toUsd(t.notionalBuy, t.buyCcy, rates));
  if (!Number.isFinite(usdEq) || usdEq <= MAX_TRADE_USD_EQ) return t;
  const scale = MAX_TRADE_USD_EQ / usdEq;
  return { ...t, notionalBuy: Math.max(1, Math.round(t.notionalBuy * scale)) };
}

function makeUsdFixTradeForCcy(s: Scenario, rates: UsdRates, ccy: Ccy, farOffset: number): SwapTrade | null {
  if (rates.status !== "ok") return null;
  if (ccy === "USD") return null;

  const balC = s.balances[ccy] ?? 0;
  const usdEq = toUsd(balC, ccy, rates);
  if (!Number.isFinite(usdEq)) return null;

  if (Math.abs(usdEq) <= TOL_USD) return null;

  // Amount in CCY that corresponds to the USD tolerance
  const tolInCcy = TOL_USD / (rates.usdPerCcy[ccy] || 1);

  // We’ll aim to move at least 50% closer (or fully into range if possible) on THIS currency
  const excess = Math.max(0, Math.abs(balC) - tolInCcy);
  const targetMove = clamp(excess, excess * 0.5, excess); // >=50% of excess
  const move = Math.max(1, Math.round(targetMove));

  const nearOffset = 0;
  if (balC < 0) {
    // short CCY => buy CCY / sell USD
    const sp = spotFromUsdRates(ccy, "USD", rates);
    if (!sp) return null;
    const fw = forwardFromSpot(sp, ccy, "USD", Math.max(1, farOffset - nearOffset));
    const t: SwapTrade = { buyCcy: ccy, sellCcy: "USD", notionalBuy: move, nearOffset, farOffset, spot: sp, fwd: fw };
    return capTradeToUsd(t, rates);
  } else {
    // long CCY => sell CCY / buy USD (swap representation buys USD)
    const sp = spotFromUsdRates("USD", ccy, rates);
    if (!sp) return null; // sellCcy per buyCcy (ccy per USD)
    const fw = forwardFromSpot(sp, "USD", ccy, Math.max(1, farOffset - nearOffset));

    // We want to SELL 'move' CCY on near. In our representation, nearSell = notionalBuy * spot (CCY).
    // So choose notionalBuy (USD) = move / spot.
    const notionalUsd = Math.max(1, Math.round(move / sp));
    const t: SwapTrade = { buyCcy: "USD", sellCcy: ccy, notionalBuy: notionalUsd, nearOffset, farOffset, spot: sp, fwd: fw };
    return capTradeToUsd(t, rates);
  }
}

function makeTileFactory(rates: UsdRates) {
  return (
    buyCcy: Ccy,
    sellCcy: Ccy,
    notionalBuy: number,
    nearOffset: number,
    farOffset: number,
    category: GuidedTile["category"],
    scoreDelta: GuidedTile["scoreDelta"],
    why: string
  ): GuidedTile => {
    const sp = spotFromUsdRates(buyCcy, sellCcy, rates) ?? Number(rand(0.6, 1.8).toFixed(6));
    const fw = forwardFromSpot(sp, buyCcy, sellCcy, Math.max(1, farOffset - nearOffset));
    const usdC = swapUsdCost({ notionalBuy, spot: sp, fwd: fw, sellCcy }, rates);
    const capped = capTradeToUsd(
      {
        buyCcy,
        sellCcy,
        notionalBuy: Math.round(notionalBuy),
        nearOffset,
        farOffset,
        spot: sp,
        fwd: fw,
      },
      rates
    );
    const usdC2 = swapUsdCost({ notionalBuy: capped.notionalBuy, spot: capped.spot, fwd: capped.fwd, sellCcy: capped.sellCcy }, rates);

    return {
      id: id(),
      ...capped,
      category,
      scoreDelta,
      why,
      usdCost: Number.isFinite(usdC2) ? usdC2 : null,
    };
  };
}

function generateGuidedTiles(s: Scenario, rates: UsdRates): GuidedTile[] {
  const makeTile = makeTileFactory(rates);
  const bal = s.balances;

  if (rates.status !== "ok") return [];

  // Build “always solvable” set:
  // - 4 strong fixes: top 4 worst currencies vs USD, sized to move >=50% closer (or into range)
  // - 2 marginals: smaller fixes on next worst
  // - 2 worses: random (still capped)
  const nonUsd = CCYS.filter((c) => c !== "USD");

  const ranked = nonUsd
    .map((c) => ({ c, usdAbs: Math.abs(toUsd(bal[c] ?? 0, c, rates) || 0) }))
    .sort((a, b) => b.usdAbs - a.usdAbs);

  const farSolve = 2;
  const farFuture = pickOne([5, 7, 10, 14]);

  const bests: GuidedTile[] = [];
  for (const item of ranked.slice(0, 4)) {
    const c = item.c;
    const t = makeUsdFixTradeForCcy(s, rates, c, farSolve) ?? makeUsdFixTradeForCcy(s, rates, c, farFuture);
    if (!t) continue;

    const before = t0ErrorUsdL1(s.balances, rates);
    const after = t0ErrorUsdL1(applyFxSwap(s, t).balances, rates);
    const improves = after < before;

    bests.push(
      makeTile(
        t.buyCcy,
        t.sellCcy,
        t.notionalBuy,
        t.nearOffset,
        t.farOffset,
        "Best",
        7,
        improves
          ? `Targets ${c} at t+0: moves it at least ~50% closer to ±$5m USD-equiv (far leg t+${t.farOffset}).`
          : `Targets ${c} at t+0 (capped): should materially reduce the biggest imbalance.`
      )
    );
  }

  // Marginals: smaller moves for next two
  const marginals: GuidedTile[] = [];
  for (const item of ranked.slice(4, 6)) {
    const c = item.c;
    const base = makeUsdFixTradeForCcy(s, rates, c, pickOne([2, 3, 5])) ?? makeUsdFixTradeForCcy(s, rates, c, pickOne([7, 10]));
    if (!base) continue;
    const smaller = { ...base, notionalBuy: Math.max(1, Math.round(base.notionalBuy * 0.6)) };
    marginals.push(
      makeTile(
        smaller.buyCcy,
        smaller.sellCcy,
        smaller.notionalBuy,
        smaller.nearOffset,
        smaller.farOffset,
        "Marginal",
        3,
        `Marginal: helps ${c} but may not be the fastest path to fully square today.`
      )
    );
  }

  // Worse tiles (random, capped)
  const worses: GuidedTile[] = [];
  const randomPair = () => {
    const buy = pickOne(CCYS);
    let sell = pickOne(CCYS);
    if (sell === buy) sell = pickOne(CCYS.filter((x) => x !== buy));
    return { buy, sell };
  };
  for (let i = 0; i < 2; i++) {
    const { buy, sell } = randomPair();
    const far = pickOne([2, 3, 5, 7, 10]);
    const n = i === 0 ? 0 : 1;
    const sp = spotFromUsdRates(buy, sell, rates) ?? 1;
    const fw = forwardFromSpot(sp, buy, sell, Math.max(1, far - n));
    const raw: SwapTrade = { buyCcy: buy, sellCcy: sell, notionalBuy: Math.round(rand(15_000_000, 90_000_000)), nearOffset: n, farOffset: far, spot: sp, fwd: fw };
    const capped = capTradeToUsd(raw, rates);
    worses.push(makeTile(capped.buyCcy, capped.sellCcy, capped.notionalBuy, capped.nearOffset, capped.farOffset, "Worse", -3, `Worse: likely to worsen today’s t+0 objective.`));
  }

  const tiles = [...bests, ...marginals, ...worses].slice(0, 8);

  // If we got too few tiles (rare), pad with safe USD fixes
  while (tiles.length < 8 && ranked.length) {
    const c = ranked[tiles.length % ranked.length].c;
    const t = makeUsdFixTradeForCcy(s, rates, c, 2);
    if (!t) break;
    tiles.push(makeTile(t.buyCcy, t.sellCcy, t.notionalBuy, t.nearOffset, t.farOffset, "Best", 7, `Targets ${c} (pad).`));
  }

  return tiles.sort(() => Math.random() - 0.5);
}

/* ----------------------------- Basic (planned day set) ----------------------------- */

type BasicSuggestion = SwapTrade & {
  id: string;
  isGood: boolean; // hidden from user, only used for scoring logic
  usdCost: number | null;
};

function pairKey(buy: Ccy, sell: Ccy) {
  return `${buy}/${sell}`;
}

function invertTrade(t: SwapTrade, rates: UsdRates): SwapTrade | null {
  // Invert to create an “incorrect-to-execute” suggestion (i.e., likely worse)
  // Use inverse spot/fwd, and use near sell amount as the new buy notional.
  const nearSellAbs = Math.abs(Math.round(t.notionalBuy * t.spot));
  const invSpot = t.spot !== 0 ? 1 / t.spot : spotFromUsdRates(t.sellCcy, t.buyCcy, rates) ?? 1;
  const invFwd = t.fwd !== 0 ? 1 / t.fwd : forwardFromSpot(invSpot, t.sellCcy, t.buyCcy, Math.max(1, t.farOffset - t.nearOffset));
  const inv: SwapTrade = {
    buyCcy: t.sellCcy,
    sellCcy: t.buyCcy,
    notionalBuy: Math.max(1, nearSellAbs),
    nearOffset: t.nearOffset,
    farOffset: t.farOffset,
    spot: invSpot,
    fwd: invFwd,
  };
  return capTradeToUsd(inv, rates);
}

function buildBasicPlan(s0: Scenario, rates: UsdRates) {
  if (rates.status !== "ok") return { suggestions: [] as BasicSuggestion[], totalPlanned: 0 };

  const totalPlanned = Math.floor(rand(BASIC_MIN_SUGGESTIONS, BASIC_MAX_SUGGESTIONS + 1));
  const needBad = BASIC_MIN_BAD_SUGGESTIONS;

  // Start from s0 and plan sequentially: mostly “good” USD fixes, with injected “bad” suggestions.
  let working = shallowCopyScenario(s0);

  const suggestions: BasicSuggestion[] = [];
  const badSlots = new Set<number>();

  // Spread bad suggestions across the plan (not first 2, not last 2)
  while (badSlots.size < needBad) {
    const idx = Math.floor(rand(2, Math.max(3, totalPlanned - 2)));
    badSlots.add(idx);
  }

  let lastPair: string | null = null;
  let lastWasBad = false;

  for (let i = 0; i < totalPlanned; i++) {
    // If already solved early, still fill the remaining with small random-but-capped “bad” (so you can keep playing),
    // but we will auto-roll as soon as the user gets solved in live play.
    const far = Math.random() < 0.8 ? 2 : pickOne([3, 5, 7]);

    // Choose target worst currency
    const worst = pickWorstNonUsdByUsdEq(working.balances, rates);
    const c = worst.ccy ?? pickOne(CCYS.filter((x) => x !== "USD"));

    let good = makeUsdFixTradeForCcy(working, rates, c, far);

    // If couldn't build, fallback to random safe trade
    if (!good) {
      const buy = pickOne(CCYS);
      let sell = pickOne(CCYS);
      if (sell === buy) sell = pickOne(CCYS.filter((x) => x !== buy));
      const sp = spotFromUsdRates(buy, sell, rates) ?? 1;
      const fw = forwardFromSpot(sp, buy, sell, Math.max(1, far));
      good = capTradeToUsd({ buyCcy: buy, sellCcy: sell, notionalBuy: Math.round(rand(10_000_000, 60_000_000)), nearOffset: 0, farOffset: far, spot: sp, fwd: fw }, rates);
    }

    // Enforce pair switch after a bad suggestion
    const wantBad = badSlots.has(i);

    let trade: SwapTrade = good;
    if (wantBad) {
      const inv = invertTrade(good, rates);
      if (inv) trade = inv;
    }

    // If last was bad, force different pair for THIS one (and generally avoid repeats)
    const thisPair = pairKey(trade.buyCcy, trade.sellCcy);
    if ((lastWasBad && lastPair && thisPair === lastPair) || (lastPair && thisPair === lastPair)) {
      // Try to switch by flipping against USD for worst currency
      const altC = c === "USD" ? "EUR" : c;
      const alt = makeUsdFixTradeForCcy(working, rates, altC, far) ?? good;
      const altPair = pairKey(alt.buyCcy, alt.sellCcy);
      if (altPair !== lastPair) {
        trade = wantBad ? invertTrade(alt, rates) ?? trade : alt;
      }
    }

    const beforeErr = t0ErrorUsdL1(working.balances, rates);
    const afterScenario = applyFxSwap(working, trade);
    const afterErr = t0ErrorUsdL1(afterScenario.balances, rates);
    const isGood = afterErr < beforeErr;

    const usdC = swapUsdCost({ notionalBuy: trade.notionalBuy, spot: trade.spot, fwd: trade.fwd, sellCcy: trade.sellCcy }, rates);

    suggestions.push({
      id: id(),
      ...trade,
      isGood,
      usdCost: Number.isFinite(usdC) ? usdC : null,
    });

    // Only advance the working scenario with “good” trades so the plan remains solvable even if user rejects bad ones
    if (!wantBad) {
      working = afterScenario;
    }

    lastPair = pairKey(trade.buyCcy, trade.sellCcy);
    lastWasBad = wantBad;
  }

  // Ensure at least 4 bad suggestions are truly “reject-correct” by making them inverted of a good fix if needed
  // (Already likely, but we enforce)
  let badCount = 0;
  for (const s of suggestions) if (!s.isGood) badCount++;
  if (badCount < needBad) {
    // force some in the middle to be inverted version of their predecessor if possible
    for (let i = 2; i < suggestions.length - 2 && badCount < needBad; i++) {
      const prev = suggestions[i - 1];
      const inv = invertTrade(prev, rates);
      if (!inv) continue;
      const beforeErr = t0ErrorUsdL1(s0.balances, rates);
      const afterErr = t0ErrorUsdL1(applyFxSwap(s0, inv).balances, rates);
      if (afterErr >= beforeErr) {
        suggestions[i] = {
          ...suggestions[i],
          ...inv,
          id: id(),
          isGood: false,
          usdCost: (() => {
            const u = swapUsdCost({ notionalBuy: inv.notionalBuy, spot: inv.spot, fwd: inv.fwd, sellCcy: inv.sellCcy }, rates);
            return Number.isFinite(u) ? u : null;
          })(),
        };
        badCount++;
      }
    }
  }

  return { suggestions, totalPlanned };
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

function Modal({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onOk} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-xl p-5">
        <div className="text-lg font-extrabold text-slate-900">{title}</div>
        <div className="mt-2 text-sm font-semibold text-slate-800 whitespace-pre-wrap">{message}</div>
        <div className="mt-4 flex justify-end">
          <button onClick={onOk} className="px-5 py-3 rounded-2xl text-sm font-extrabold bg-slate-900 text-white hover:bg-slate-800 transition">
            OK
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
};

type BasicDecision = {
  id: string;
  action: "execute" | "reject";
  wasGood: boolean;
  correct: boolean;
  timestamp: number;
};

export default function Page() {
  const [tab, setTab] = useState<Tab>("home");
  const [dayNumber, setDayNumber] = useState(1);

  const [previewEnabled, setPreviewEnabled] = useState(false);

  // Modal state (rolling + outcomes)
  const [modal, setModal] = useState<{ open: boolean; title: string; message: string; onOk?: () => void }>({
    open: false,
    title: "",
    message: "",
  });

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
  const [scenario, setScenario] = useState<Scenario>(() => generateGuidedSolvableScenario());

  // Trade log (actual executed swaps)
  const [tradeLog, setTradeLog] = useState<TradeLogItem[]>([]);

  // Day cost history (tiles): prior days are “locked”; current day is live.
  const [dayCosts, setDayCosts] = useState<number[]>([]); // index 0 => Day 1 locked cost, etc.

  const totalCost = useMemo(() => {
    let t = 0;
    for (const x of tradeLog) if (Number.isFinite(x.usdCost as any)) t += x.usdCost as number;
    return t;
  }, [tradeLog]);

  function logTrade(t: SwapTrade, opts?: { correct?: boolean; mode?: TradeLogItem["mode"]; labelOverride?: string }) {
    const usdC =
      ratesRef.current.status === "ok"
        ? swapUsdCost({ notionalBuy: t.notionalBuy, spot: t.spot, fwd: t.fwd, sellCcy: t.sellCcy }, ratesRef.current)
        : NaN;

    const label =
      opts?.labelOverride ??
      `Buy ${t.buyCcy} / Sell ${t.sellCcy} · ${formatM(t.notionalBuy)} ${t.buyCcy}`;

    setTradeLog((prev) => [
      {
        id: id(),
        label,
        usdCost: Number.isFinite(usdC) ? usdC : null,
        timestamp: Date.now(),
        correct: opts?.correct,
        mode: opts?.mode,
      },
      ...prev,
    ]);
  }

  // -------- Roll evaluation + execution (centralized) --------

  function evaluateRollMessage(context: "basic" | "guided" | "manual") {
    const r = ratesRef.current;
    if (r.status !== "ok") {
      return { title: "Rolling value date", message: "Rates are still loading. Rolling will proceed using the current scenario state." };
    }

    const solved = nonUsdSquaredAtT0UsdEq(scenario.balances, r);
    const idle = allNonUsdLongButSomeIdle(scenario.balances, r);
    const allLong = (() => {
      for (const c of CCYS) {
        if (c === "USD") continue;
        const usdEq = toUsd(scenario.balances[c] ?? 0, c, r);
        if (!Number.isFinite(usdEq)) return false;
        if (usdEq < -TOL_USD) return false;
      }
      return true;
    })();

    if (context === "manual") {
      if (!solved && !allLong) {
        return { title: "Roll Value Date", message: "We were short - Customer payments didn't go out, bad day at the office" };
      }
      if (solved) return { title: "Roll Value Date", message: "Well done, the value date will now roll" };
      if (idle) return { title: "Roll Value Date", message: "Everything got funded, but we left idle cash on the table" };
      return { title: "Roll Value Date", message: "You ran out of time, the value date will now roll" };
    }

    // basic/guided
    if (solved) return { title: "Roll Value Date", message: "Well done, the value date will now roll" };
    if (idle) return { title: "Roll Value Date", message: "Everything got funded, but we left idle cash on the table" };
    return { title: "Roll Value Date", message: "You ran out of time, the value date will now roll" };
  }

  function doRollDay() {
    // lock in current day's cost into history before resetting today
    setDayCosts((prev) => [...prev, totalCost]);

    setScenario((s) => rollValueDate(s));
    setDayNumber((d) => d + 1);
    setTradeLog([]);

    // reset guided/basic/manual per-day state
    resetGuidedForNewDay();
    resetBasicForNewDay(true);
    setManualPreview(null);
  }

  function openRollModal(context: "basic" | "guided" | "manual") {
    const { title, message } = evaluateRollMessage(context);
    setModal({
      open: true,
      title,
      message,
      onOk: () => {
        setModal({ open: false, title: "", message: "" });
        doRollDay();
      },
    });
  }

  // -------- Basic state --------

  const [basicDecisions, setBasicDecisions] = useState<BasicDecision[]>([]);
  const basicCorrect = useMemo(() => basicDecisions.filter((d) => d.correct).length, [basicDecisions]);
  const basicTotal = basicDecisions.length;

  const [basicPlan, setBasicPlan] = useState<BasicSuggestion[]>([]);
  const [basicIdx, setBasicIdx] = useState(0);

  const basicSuggestion = basicPlan[basicIdx] ?? null;

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

  function recordBasicDecision(action: "execute" | "reject", wasGood: boolean, correct: boolean) {
    setBasicDecisions((prev) => [{ id: id(), action, wasGood, correct, timestamp: Date.now() }, ...prev]);
  }

  function resetBasicForNewDay(forceRebuild: boolean) {
    setBasicIncorrect({ active: false });
    setBasicIdx(0);
    if (forceRebuild && ratesRef.current.status === "ok") {
      const { suggestions } = buildBasicPlan(scenario, ratesRef.current);
      setBasicPlan(suggestions);
    }
  }

  // Build basic plan when rates become OK or scenario changes day-to-day
  useEffect(() => {
    if (rates.status !== "ok") return;
    const { suggestions } = buildBasicPlan(scenario, rates);
    setBasicPlan(suggestions);
    setBasicIdx(0);
    setBasicIncorrect({ active: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rates.status, dayNumber]);

  function advanceBasic() {
    setBasicIdx((i) => Math.min(i + 1, Math.max(0, basicPlan.length - 1)));
  }

  function basicChoose(action: "execute" | "reject") {
    if (!basicSuggestion || ratesRef.current.status !== "ok") return;

    const s0 = scenario;
    const beforeErr = t0ErrorUsdL1(s0.balances, ratesRef.current);
    const afterScenario = applyFxSwap(s0, basicSuggestion);
    const afterErr = t0ErrorUsdL1(afterScenario.balances, ratesRef.current);
    const improves = afterErr < beforeErr; // “good” trade

    const correct = action === "execute" ? improves : !improves;
    recordBasicDecision(action, improves, correct);

    if (correct) {
      if (action === "execute") {
        setScenario(afterScenario);
        logTrade(basicSuggestion, { correct: true, mode: "basic" });
      }
      setBasicIncorrect({ active: false });

      // Check solved now (after execution if executed, else current)
      const cur = action === "execute" ? afterScenario : s0;
      if (ratesRef.current.status === "ok" && nonUsdSquaredAtT0UsdEq(cur.balances, ratesRef.current)) {
        setModal({
          open: true,
          title: "Nice work",
          message: "Well Done, the value date will now roll",
          onOk: () => {
            setModal({ open: false, title: "", message: "" });
            doRollDay();
          },
        });
        return;
      }

      advanceBasic();
      return;
    }

    // Wrong: execute anyway, show changed cells with prev values, allow undo
    const { changed, prev } = diffCellsAndPrev(s0, afterScenario);
    setScenario(afterScenario);
    logTrade(basicSuggestion, { correct: false, mode: "basic" });
    setBasicIncorrect({ active: true, lastScenarioBefore: s0, changedCells: changed, prevValues: prev });
  }

  function basicUndoAndNext() {
    if (!basicIncorrect.active || !basicIncorrect.lastScenarioBefore || ratesRef.current.status !== "ok") return;
    const restored = basicIncorrect.lastScenarioBefore;
    setScenario(restored);
    setBasicIncorrect({ active: false });
    advanceBasic(); // next suggestion (plan already ensures different pair after bad offerings)
  }

  const basicMovesLeft = Math.max(0, basicPlan.length - basicIdx);

  // -------- Guided state --------

  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedScore, setGuidedScore] = useState(0);
  const [guidedTiles, setGuidedTiles] = useState<GuidedTile[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<GuidedTile | null>(null);
  const [previewScenario, setPreviewScenario] = useState<Scenario | null>(null);

  // Track history for undo + reversal prompts
  const [guidedHistory, setGuidedHistory] = useState<Array<{ before: Scenario; trade: SwapTrade; tradeLogLabel: string }>>([]);
  const [guidedReversalPrompt, setGuidedReversalPrompt] = useState<null | { before: Scenario; trade: GuidedTile }>(null);

  const swapsLeft = GUIDED_STEPS_PER_DAY - guidedStep;

  function resetGuidedForNewDay() {
    setGuidedStep(0);
    setGuidedScore(0);
    setSelected(null);
    setPreviewScenario(null);
    setRevealed(new Set());
    setGuidedHistory([]);
    setGuidedReversalPrompt(null);
    if (ratesRef.current.status === "ok") {
      setGuidedTiles(generateGuidedTiles(scenario, ratesRef.current));
    } else {
      setGuidedTiles([]);
    }
  }

  useEffect(() => {
    if (rates.status !== "ok") return;
    setGuidedTiles(generateGuidedTiles(scenario, rates));
    setPreviewScenario(null);
    setSelected(null);
    setRevealed(new Set());
    setGuidedReversalPrompt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, rates.status]);

  function previewGuided(t: GuidedTile) {
    if (!previewEnabled) return;
    setPreviewScenario(applyFxSwap(scenario, t));
  }

  function clearPreview() {
    setPreviewScenario(null);
    setManualPreview(null);
  }

  function undoLastGuidedTrade() {
    setGuidedReversalPrompt(null);
    setGuidedHistory((hist) => {
      if (hist.length === 0) return hist;
      const last = hist[0];
      setScenario(last.before);
      setGuidedStep((x) => Math.max(0, x - 1));
      // Remove the most recent tradeLog item (we logged it at the front)
      setTradeLog((prev) => prev.slice(1));
      setSelected(null);
      setPreviewScenario(null);
      setRevealed((prev) => {
        const n = new Set(prev);
        // keep revealed as-is; user already saw outcomes
        return n;
      });
      return hist.slice(1);
    });
  }

  function makeReversalTrade(t: GuidedTile): SwapTrade | null {
    // Reverse near leg approximately:
    // Buy original sellCcy (amount ~= nearSellAbs) / Sell original buyCcy at inverse spot/fwd.
    const nearSellAbs = Math.abs(Math.round(t.notionalBuy * t.spot));
    const invSpot = t.spot !== 0 ? 1 / t.spot : null;
    const invFwd = t.fwd !== 0 ? 1 / t.fwd : null;
    if (!invSpot || !invFwd) return null;

    const rev: SwapTrade = {
      buyCcy: t.sellCcy,
      sellCcy: t.buyCcy,
      notionalBuy: Math.max(1, nearSellAbs),
      nearOffset: t.nearOffset,
      farOffset: t.farOffset,
      spot: invSpot,
      fwd: invFwd,
    };

    if (ratesRef.current.status === "ok") return capTradeToUsd(rev, ratesRef.current);
    return rev;
  }

  function executeGuided(t: GuidedTile) {
    if (ratesRef.current.status !== "ok") return;
    if (guidedStep >= GUIDED_STEPS_PER_DAY) return;

    const before = scenario;
    const beforeErr = t0ErrorUsdL1(before.balances, ratesRef.current);

    const after = applyFxSwap(before, t);
    const afterErr = t0ErrorUsdL1(after.balances, ratesRef.current);
    const improves = afterErr < beforeErr;

    setScenario(after);

    setRevealed((prev) => {
      const n = new Set(prev);
      n.add(t.id);
      return n;
    });
    setSelected(t);

    // scoring scaled for 15 swaps (max 100)
    setGuidedScore((x) => clamp(x + (t.category === "Best" ? 7 : t.category === "Marginal" ? 3 : -3), 0, 100));

    const label = `Buy ${t.buyCcy} / Sell ${t.sellCcy} · ${formatM(t.notionalBuy)} ${t.buyCcy}`;
    logTrade(t, { correct: improves, mode: "guided", labelOverride: label });

    // push history for undo (store newest at front)
    setGuidedHistory((prev) => [{ before, trade: t, tradeLogLabel: label }, ...prev]);

    setGuidedStep((x) => x + 1);
    setPreviewScenario(null);

    if (!improves) {
      setGuidedReversalPrompt({ before, trade: t });
    } else {
      setGuidedReversalPrompt(null);
    }
  }

  // When guided swaps run out, show outcome modal then roll
  useEffect(() => {
    if (tab !== "guided") return;
    if (rates.status !== "ok") return;
    if (guidedStep < GUIDED_STEPS_PER_DAY) return;

    const solved = nonUsdSquaredAtT0UsdEq(scenario.balances, rates);
    const idle = allNonUsdLongButSomeIdle(scenario.balances, rates);

    const message = solved
      ? "Well done, the value date will now roll"
      : idle
      ? "Everything got funded, but we left idle cash on the table"
      : "You ran out of time, the value date will now roll";

    setModal({
      open: true,
      title: "Day complete",
      message,
      onOk: () => {
        setModal({ open: false, title: "", message: "" });
        doRollDay();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedStep, tab, rates.status]);

  // -------- Manual swap entry --------

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

    // Cap manual too? (not requested, but keeps consistency)
    const t0: SwapTrade = { buyCcy, sellCcy, notionalBuy: Math.round(nBuy), nearOffset: mNear, farOffset: mFar, spot: sp, fwd: fw };
    return capTradeToUsd(t0, ratesRef.current);
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

  /* ----------------------------- Reset ----------------------------- */

  function resetAll() {
    const s = generateGuidedSolvableScenario();
    setScenario(s);
    setDayNumber(1);
    setTradeLog([]);
    setDayCosts([]);
    setBasicDecisions([]);

    setGuidedStep(0);
    setGuidedScore(0);
    setGuidedTiles([]);
    setRevealed(new Set());
    setSelected(null);
    setPreviewScenario(null);
    setGuidedHistory([]);
    setGuidedReversalPrompt(null);

    setBasicIncorrect({ active: false });
    setBasicIdx(0);
    setBasicPlan([]);

    setManualPreview(null);

    // reset manual fields
    setC1("EUR");
    setC2("USD");
    setNearBuysC1(true);
    setMNear(0);
    setMFar(2);
    setActiveField("nearBuy");
    setNearBuyStr("25,000,000");
  }

  const displayScenario = tab === "guided" ? previewScenario ?? scenario : tab === "manual" ? manualPreview ?? scenario : scenario;

  const solvedNowUsdEq = useMemo(() => (rates.status === "ok" ? nonUsdSquaredAtT0UsdEq(scenario.balances, rates) : false), [scenario, rates.status]);
  const guidedSolvedUsdEq = useMemo(
    () => (rates.status === "ok" ? nonUsdSquaredAtT0UsdEq((previewScenario ?? scenario).balances, rates) : false),
    [scenario, previewScenario, rates.status]
  );

  const objectiveBanner = (
    <>
      <div className="text-sm font-semibold text-slate-900">
        Objective: square all <span className="font-bold">non-USD</span> <span className="font-bold">t+0</span> positions to within{" "}
        <span className="font-bold">±$5m USD-equiv</span>. USD is exempt.
      </div>
      <div className="text-sm font-semibold text-slate-900">
        Blotter cells are shown in the <span className="font-bold">native currency</span> on the left; the objective check is done in{" "}
        <span className="font-bold">USD-equivalent</span>.
      </div>
      <div className="text-sm font-semibold text-slate-900">
        t+1..t+14 columns show <span className="font-bold">net cashflow</span> for that date (seeded trades + your swaps), not a predicted balance.
      </div>
    </>
  );

  const ratesList = useMemo(() => {
    const items = CCYS.map((c) => ({ ccy: c, cPerUsd: rates.ccyPerUsd[c], usdPerC: rates.usdPerCcy[c] }));
    return items.sort((a, b) => a.ccy.localeCompare(b.ccy));
  }, [rates]);

  // Day tiles: show locked days + current day live
  const dayTiles = useMemo(() => {
    const locked = dayCosts.map((v, idx) => ({ day: idx + 1, cost: v, locked: true }));
    const current = { day: dayNumber, cost: totalCost, locked: false };
    return [...locked, current];
  }, [dayCosts, dayNumber, totalCost]);

  const costPanel = (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
      <div className="flex flex-wrap items-start gap-3">
        {dayTiles.map((d) => (
          <Pill key={`${d.day}-${d.locked ? "locked" : "live"}`} label={`Day ${d.day} USD cost/gain`} value={`$${formatInt(d.cost)}`} />
        ))}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={clearPreview}
            className="px-4 py-3 rounded-2xl text-sm font-semibold border border-slate-200 bg-white hover:bg-slate-50 transition text-slate-900"
          >
            Clear preview
          </button>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200">
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
        <div className="px-4 py-3 bg-white border-t border-slate-200 flex items-center">
          <div className="text-sm font-bold text-slate-900">Running total (today)</div>
          <div className="ml-auto text-sm font-bold text-slate-900">${formatInt(totalCost)}</div>
        </div>
      </div>
    </div>
  );

  // FX rates panel
  const fxRatesPanel = (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 max-w-3xl">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-slate-900">FX Rates vs USD</div>
          <div className="text-sm font-semibold text-slate-900">Source: frankfurter.app {rates.asOf ? `· As of ${rates.asOf}` : ""}</div>
        </div>
        <div className="text-sm font-semibold text-slate-900">
          {rates.status === "loading" ? "Loading…" : rates.status === "error" ? `Error: ${rates.error}` : "Live"}
        </div>
      </div>

      <div className="mt-4 overflow-auto rounded-2xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-white">
            <tr>
              <th className="text-left p-2 border-b border-slate-200 text-slate-900 font-semibold">CCY</th>
              <th className="text-right p-2 border-b border-slate-200 text-slate-900 font-semibold">1 USD =</th>
              <th className="text-right p-2 border-b border-slate-200 text-slate-900 font-semibold">1 CCY =</th>
            </tr>
          </thead>
          <tbody>
            {ratesList.map((r) => (
              <tr key={r.ccy} className="border-b border-slate-100 last:border-b-0">
                <td className="p-2 font-semibold text-slate-900">{r.ccy}</td>
                <td className="p-2 text-right font-semibold text-slate-900">
                  {fmt4(r.cPerUsd)} {r.ccy}
                </td>
                <td className="p-2 text-right font-semibold text-slate-900">
                  {fmt4(r.usdPerC)} USD
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="h-4" />
      <div className="text-xs font-semibold text-slate-700">Note: Carry/forwards are simplified using static IR assumptions + a small forward-points spread.</div>
    </div>
  );

  const { buyCcy: manualBuyCcy, sellCcy: manualSellCcy } = getManualBuySell();
  const manualSpot = useMemo(() => {
    if (rates.status !== "ok") return null;
    if (c1 === c2) return null;
    return spotFromUsdRates(manualBuyCcy, manualSellCcy, rates);
  }, [rates.status, c1, c2, manualBuyCcy, manualSellCcy, rates]);

  const manualFwd = useMemo(() => {
    if (!manualSpot) return null;
    return forwardFromSpot(manualSpot, manualBuyCcy, manualSellCcy, Math.max(1, mFar - mNear));
  }, [manualSpot, manualBuyCcy, manualSellCcy, mFar, mNear]);

  // Guided tile counter amount helper (near leg)
  function counterAmountNear(t: { notionalBuy: number; spot: number }) {
    return Math.round(t.notionalBuy * t.spot);
  }

  return (
    <div className="min-h-screen bg-[#001B5E]">
      <Modal
        open={modal.open}
        title={modal.title}
        message={modal.message}
        onOk={() => {
          if (modal.onOk) modal.onOk();
          else setModal({ open: false, title: "", message: "" });
        }}
      />

      <div className="max-w-7xl mx-auto p-6 pb-24 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            {/* Simple logo mark (inline) */}
            <div className="w-9 h-9 rounded-2xl bg-white flex items-center justify-center shadow-sm">
              <div className="text-[#001B5E] font-extrabold text-lg leading-none">r</div>
            </div>

            <div className="flex flex-col">
              <div className="text-2xl font-semibold text-white">Remitly Treasury</div>
              <h1 className="text-2xl font-semibold text-white">FRD Book Management 101</h1>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
            <TabButton active={tab === "home"} onClick={() => setTab("home")}>
              Home
            </TabButton>
            <TabButton active={tab === "basic"} onClick={() => setTab("basic")}>
              Basic
            </TabButton>
            <TabButton active={tab === "guided"} onClick={() => setTab("guided")}>
              Guided
            </TabButton>
            <TabButton active={tab === "manual"} onClick={() => setTab("manual")}>
              Manual
            </TabButton>

            <button
              onClick={() => setPreviewEnabled((v) => !v)}
              className={classNames(
                "px-4 py-2 rounded-xl text-sm font-semibold border transition",
                previewEnabled ? "bg-white text-slate-900 border-white hover:bg-white/90" : "bg-transparent text-white border-white/30 hover:bg-white/10"
              )}
              title="When OFF, hides preview controls (Guided/Manual)."
            >
              Preview: {previewEnabled ? "On" : "Off"}
            </button>

            <button
              onClick={resetAll}
              className="px-4 py-2 rounded-xl text-sm font-semibold border border-white/30 bg-transparent hover:bg-white/10 transition text-white"
            >
              Reset
            </button>

            <button
              onClick={() => {
                const context: "basic" | "guided" | "manual" = tab === "guided" ? "guided" : tab === "manual" ? "manual" : "basic";
                openRollModal(context);
              }}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-white text-slate-900 hover:bg-white/90 transition"
              title="Roll value date (nets t+1 into t+0 and shifts horizon)."
            >
              Roll Value Date
            </button>
          </div>
        </div>

        {/* HOME */}
        {tab === "home" ? (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
              <div className="text-xl font-extrabold text-slate-900">What this tool is</div>
              <p className="mt-3 text-sm font-semibold text-slate-800 leading-relaxed">
                This simulator is a hands-on training tool for learning how FX swaps change cash positions over a rolling value-date horizon. The blotter is shown in “cashflow view”:{" "}
                <span className="font-bold">t+0 is cash at bank plus executed trades</span>, and <span className="font-bold">t+1..t+14</span> are net cashflows expected on those dates.
              </p>

              <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm font-extrabold text-slate-900">Your objective</div>
                  <ul className="mt-2 list-disc ml-5 text-sm font-semibold text-slate-800 space-y-1">
                    <li>
                      Square all <span className="font-bold">non-USD</span> <span className="font-bold">t+0</span> positions within{" "}
                      <span className="font-bold">±$5m USD-equivalent</span>.
                    </li>
                    <li>USD is exempt (but remains large and positive).</li>
                    <li>Blotter values are shown in native currency; the objective uses USD-equivalent.</li>
                  </ul>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm font-extrabold text-slate-900">How to progress</div>
                  <ul className="mt-2 list-disc ml-5 text-sm font-semibold text-slate-800 space-y-1">
                    <li>
                      Start in <span className="font-bold">Basic</span>: decide Execute vs Reject for one suggestion at a time.
                    </li>
                    <li>
                      Move to <span className="font-bold">Guided</span>: choose among multiple swaps (including crosses) and learn trade-offs.
                    </li>
                    <li>
                      Graduate to <span className="font-bold">Manual</span>: you build swaps yourself using a trader-style entry.
                    </li>
                  </ul>
                </div>
              </div>

              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-extrabold text-slate-900">Markets explainer</div>

                <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-extrabold text-slate-900">Spot FX</div>
                    <div className="mt-2 text-sm font-semibold text-slate-800">
                      <span className="font-bold">Spot</span> is the price for exchanging two currencies for near settlement.
                      In this trainer, we use spot to value the near leg and show the immediate impact on <span className="font-bold">t+0</span> positions.
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-extrabold text-slate-900">Forward FX</div>
                    <div className="mt-2 text-sm font-semibold text-slate-800">
                      <span className="font-bold">Forwards</span> lock in an exchange rate for a future date. The forward differs from spot because of the{" "}
                      <span className="font-bold">interest rate differential</span> between the two currencies.
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-extrabold text-slate-900">Forward points</div>
                    <div className="mt-2 text-sm font-semibold text-slate-800">
                      <span className="font-bold">Forward points</span> are simply: <span className="font-bold">Forward − Spot</span>. Dealers often quote points rather than the outright forward.
                      In this app we compute a simple forward using IRs and add a small <span className="font-bold">1.5bp</span> spread to points so it’s not free to round-trip.
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-sm font-extrabold text-slate-900">Carry</div>
                    <div className="mt-2 text-sm font-semibold text-slate-800">
                      <span className="font-bold">Carry</span> is the P&L you earn/pay from holding currency funding over time (via the IR differential, reflected in forward points).
                      In swaps, carry shows up as the difference between the near and far exchange amounts.
                    </div>
                  </div>
                </div>

                {/* Removed entire “Ask a question…” section per request */}
              </div>
            </div>

            <Banner dayNumber={dayNumber} />

            <div className="space-y-2">
              <Blotter scenario={scenario} />
              {objectiveBanner}
            </div>
          </div>
        ) : null}

        {/* Non-home: Day banner always just above blotter */}
        {tab !== "home" ? (
          <div className="space-y-4">
            <Banner dayNumber={dayNumber} />
            <div className="space-y-2">
              <Blotter scenario={displayScenario} highlightCells={tab === "basic" ? basicIncorrect.changedCells : undefined} prevValues={tab === "basic" ? basicIncorrect.prevValues : undefined} />
              {objectiveBanner}
            </div>
          </div>
        ) : null}

        {/* BASIC */}
        {tab === "basic" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Pill label="Solved (USD-equiv)" value={solvedNowUsdEq ? "✅ Yes" : "No"} />
              <Pill label="Basic accuracy" value={`${basicCorrect} / ${basicTotal}`} />
              <Pill label="Moves left (planned)" value={basicMovesLeft} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-semibold text-slate-900">
                  Decide whether to <span className="font-bold">Execute</span> or <span className="font-bold">Reject</span> based on what it does to{" "}
                  <span className="font-bold">t+0</span> (USD-equivalent squaring).
                </div>

                {basicIncorrect.active ? (
                  <div className="px-3 py-2 rounded-xl bg-rose-100 text-rose-900 font-bold text-sm border border-rose-200">Incorrect</div>
                ) : null}
              </div>

              <div className="mt-4 relative">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  {basicSuggestion ? (
                    <div className="flex flex-col gap-2">
                      <div className="text-base font-bold text-slate-900">
                        Buy {basicSuggestion.buyCcy} / Sell {basicSuggestion.sellCcy}
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        Notional: {formatM(basicSuggestion.notionalBuy)} {basicSuggestion.buyCcy}{" "}
                        <span className="text-slate-600">· Counter (near): {formatM(counterAmountNear(basicSuggestion))} {basicSuggestion.sellCcy}</span>
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        Near: t+{basicSuggestion.nearOffset} · Far: t+{basicSuggestion.farOffset} (Near always t+0)
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        USD carry (approx): {basicSuggestion.usdCost === null ? "—" : `$${formatInt(basicSuggestion.usdCost)}`}
                      </div>

                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => basicChoose("execute")}
                          disabled={basicIncorrect.active}
                          className={classNames(
                            "flex-1 px-4 py-3 rounded-2xl text-sm font-bold transition",
                            basicIncorrect.active ? "bg-slate-200 text-slate-500" : "bg-slate-900 text-white hover:bg-slate-800"
                          )}
                        >
                          Execute
                        </button>
                        <button
                          onClick={() => basicChoose("reject")}
                          disabled={basicIncorrect.active}
                          className={classNames(
                            "flex-1 px-4 py-3 rounded-2xl text-sm font-bold border transition",
                            basicIncorrect.active ? "border-slate-200 bg-slate-200 text-slate-500" : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                          )}
                        >
                          Reject
                        </button>
                      </div>

                      {basicIncorrect.active ? (
                        <div className="mt-3 flex flex-col md:flex-row md:items-center gap-3">
                          <button onClick={basicUndoAndNext} className="px-5 py-3 rounded-2xl text-sm font-extrabold bg-rose-600 text-white hover:bg-rose-700 transition shadow-sm">
                            Undo & Next
                          </button>
                          <div className="text-sm font-semibold text-slate-700">
                            Yellow outlines show cells changed by the (incorrect) executed swap — each also shows the <span className="font-bold">prev.</span> amount.
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-sm font-semibold text-slate-700">
                      {rates.status === "loading" ? "Loading rates…" : rates.status === "error" ? `Rates error: ${rates.error}` : "No plan loaded yet."}
                    </div>
                  )}
                </div>

                {basicIncorrect.active ? (
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="px-5 py-3 rounded-2xl bg-white/90 border border-rose-200 text-rose-900 font-extrabold shadow-sm">
                      Incorrect - review blotter to see what this would do to your positions
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {costPanel}
            <div>{fxRatesPanel}</div>
          </div>
        ) : null}

        {/* GUIDED */}
        {tab === "guided" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Pill label="Swaps left" value={swapsLeft} />
              <Pill label="Score (out of 100)" value={guidedScore} />

              <button
                onClick={undoLastGuidedTrade}
                disabled={guidedHistory.length === 0}
                className={classNames(
                  "px-4 py-3 rounded-2xl text-sm font-extrabold border transition",
                  guidedHistory.length === 0 ? "border-slate-200 bg-slate-200 text-slate-500" : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                )}
              >
                Undo Last Trade
              </button>

              {guidedSolvedUsdEq ? (
                <div className="px-4 py-3 rounded-2xl bg-emerald-100 text-emerald-900 font-bold text-sm border border-emerald-200">
                  ✅ Solved (non-USD t+0 within ±$5m USD-equiv)
                </div>
              ) : null}
            </div>

            <div className="text-lg font-semibold text-white">Choose an FX swap (USD + crosses)</div>

            {guidedReversalPrompt ? (
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
                <div className="text-sm font-extrabold text-slate-900">This went the wrong way, execute a reversal?</div>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      // YES: revert blotter to before, but keep original trade in cost tracker and add reversal entry
                      const { before, trade } = guidedReversalPrompt;
                      const rev = makeReversalTrade(trade);
                      setScenario(before);
                      setGuidedReversalPrompt(null);
                      setSelected(null);
                      setPreviewScenario(null);

                      if (rev) {
                        logTrade(rev, {
                          correct: undefined,
                          mode: "guided",
                          labelOverride: `REVERSAL · Buy ${rev.buyCcy} / Sell ${rev.sellCcy} · ${formatM(rev.notionalBuy)} ${rev.buyCcy}`,
                        });
                      }
                      // Do NOT change guidedStep (reversal does not consume extra “swaps left”)
                    }}
                    className="px-4 py-3 rounded-2xl text-sm font-extrabold bg-slate-900 text-white hover:bg-slate-800 transition"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setGuidedReversalPrompt(null)}
                    className="px-4 py-3 rounded-2xl text-sm font-extrabold border border-slate-200 bg-white text-slate-900 hover:bg-slate-50 transition"
                  >
                    No
                  </button>
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {guidedTiles.map((t) => {
                const counter = counterAmountNear(t);
                return (
                  <div key={t.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 truncate">
                          Buy {t.buyCcy} / Sell {t.sellCcy}
                        </div>
                        <div className="text-sm text-slate-900 font-semibold mt-1">
                          Notional: {formatM(t.notionalBuy)} {t.buyCcy}
                        </div>
                        <div className="text-sm text-slate-900 font-semibold">
                          Counter (near): {formatM(counter)} {t.sellCcy}
                        </div>
                        <div className="text-sm text-slate-900 font-semibold">
                          Near: t+{t.nearOffset} · Far: t+{t.farOffset}
                        </div>
                        <div className="text-xs text-slate-900 font-semibold mt-1">USD carry (approx): {t.usdCost === null ? "—" : `$${formatInt(t.usdCost)}`}</div>
                      </div>
                      {revealed.has(t.id) ? (
                        <div
                          className={classNames(
                            "text-xs px-2 py-1 rounded-lg font-semibold",
                            t.category === "Best" ? "bg-emerald-100 text-emerald-900" : t.category === "Marginal" ? "bg-amber-100 text-amber-900" : "bg-rose-100 text-rose-900"
                          )}
                        >
                          {t.category} ({t.scoreDelta > 0 ? `+${t.scoreDelta}` : t.scoreDelta})
                        </div>
                      ) : null}
                    </div>

                    <div className="flex gap-2">
                      {previewEnabled ? (
                        <button
                          onClick={() => previewGuided(t)}
                          className="flex-1 px-3 py-2 rounded-xl text-sm font-semibold border border-slate-200 bg-white hover:bg-slate-50 transition text-slate-900"
                        >
                          Preview
                        </button>
                      ) : null}

                      <button
                        onClick={() => {
                          executeGuided(t);
                          setRevealed((prev) => {
                            const n = new Set(prev);
                            n.add(t.id);
                            return n;
                          });
                        }}
                        className={classNames("px-3 py-2 rounded-xl text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800 transition", previewEnabled ? "flex-1" : "w-full")}
                      >
                        Execute
                      </button>
                    </div>

                    {revealed.has(t.id) ? <div className="text-sm font-semibold text-slate-900">{t.why}</div> : null}
                  </div>
                );
              })}
            </div>

            {selected ? (
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
                <div className="text-sm font-semibold text-slate-900">Last trade</div>
                <div className="text-lg font-bold text-slate-900 mt-1">
                  Buy {selected.buyCcy} / Sell {selected.sellCcy} · Near t+{selected.nearOffset} · Far t+{selected.farOffset}
                </div>
                <div className="text-sm font-semibold text-slate-900 mt-2">{selected.why}</div>
              </div>
            ) : null}

            {costPanel}
            <div>{fxRatesPanel}</div>
          </div>
        ) : null}

        {/* MANUAL */}
        {tab === "manual" ? (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-slate-900">Manual swap entry</div>
                  <div className="text-sm font-semibold text-slate-900 mt-1">Edit any one box and the rest auto-calc.</div>
                </div>
                <div className="text-sm font-bold text-slate-900">
                  Swap cost/gain: <span className="font-extrabold">{manualDraftCost === null ? "—" : `$${formatInt(manualDraftCost)}`}</span>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Currency 1</div>
                  <select value={c1} onChange={(e) => setC1(e.target.value)} className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold">
                    {CCYS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Currency 2</div>
                  <select value={c2} onChange={(e) => setC2(e.target.value)} className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold">
                    {CCYS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {c2 === c1 ? <div className="text-xs font-bold text-rose-700 mt-2">Currency 1 and 2 must differ.</div> : null}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Near</div>
                  <select value={mNear} onChange={(e) => setMNear(Number(e.target.value))} className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold">
                    {Array.from({ length: HORIZON }, (_, i) => i).map((t) => (
                      <option key={t} value={t}>
                        t+{t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Far</div>
                  <select value={mFar} onChange={(e) => setMFar(Number(e.target.value))} className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold">
                    {Array.from({ length: HORIZON }, (_, i) => i)
                      .filter((t) => t > mNear)
                      .map((t) => (
                        <option key={t} value={t}>
                          t+{t}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <div className="text-sm font-bold text-slate-900">Near leg direction</div>
                <button
                  onClick={() => setNearBuysC1((v) => !v)}
                  className={classNames(
                    "px-4 py-2 rounded-xl text-sm font-extrabold border transition",
                    nearBuysC1 ? "bg-slate-900 text-white border-slate-900 hover:bg-slate-800" : "bg-white text-slate-900 border-slate-200 hover:bg-slate-50"
                  )}
                  title="Toggle whether near leg buys Currency 1 or sells Currency 1."
                >
                  {nearBuysC1 ? `Buy ${c1} / Sell ${c2} (near)` : `Sell ${c1} / Buy ${c2} (near)`}
                </button>

                <div className="ml-auto text-sm font-semibold text-slate-700">
                  {rates.status === "ok" && manualSpot ? (
                    <>
                      Spot: <span className="font-bold text-slate-900 ml-1">{manualSpot.toFixed(6)}</span>
                      <span className="mx-2 text-slate-400">•</span>
                      Fwd: <span className="font-bold text-slate-900 ml-1">{manualFwd ? manualFwd.toFixed(6) : "—"}</span>
                    </>
                  ) : (
                    <span>Rates: {rates.status === "loading" ? "Loading…" : rates.status === "error" ? "Error" : "—"}</span>
                  )}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
                <div className="grid grid-rows-2 gap-3">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Near Buy (+ {manualBuyCcy})</div>
                    <input
                      value={nearBuyStr}
                      onFocus={() => setActiveField("nearBuy")}
                      onChange={(e) => setNearBuyStr(formatWithCommasDigitsOnly(e.target.value))}
                      inputMode="numeric"
                      className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                      placeholder="e.g. 25,000,000"
                    />
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Near Sell (- {manualSellCcy})</div>
                    <input
                      value={nearSellStr}
                      onFocus={() => setActiveField("nearSell")}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^\d]/g, "");
                        setNearSellStr(raw ? `-${formatWithCommasDigitsOnly(raw)}` : "");
                      }}
                      inputMode="numeric"
                      className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                      placeholder="-…"
                    />
                  </div>
                </div>

                <div className="grid grid-rows-2 gap-3">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Far Sell (+ {manualSellCcy})</div>
                    <input
                      value={farSellStr}
                      onFocus={() => setActiveField("farSell")}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^\d]/g, "");
                        setFarSellStr(raw ? `+${formatWithCommasDigitsOnly(raw)}` : "");
                      }}
                      inputMode="numeric"
                      className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                      placeholder="+…"
                    />
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Far Buy (- {manualBuyCcy})</div>
                    <input
                      value={farBuyStr}
                      onFocus={() => setActiveField("farBuy")}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^\d]/g, "");
                        setFarBuyStr(raw ? `-${formatWithCommasDigitsOnly(raw)}` : "");
                      }}
                      inputMode="numeric"
                      className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                      placeholder="-…"
                    />
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2 items-center">
                {previewEnabled ? (
                  <>
                    <button
                      onClick={() => {
                        const t = buildTradeFromManual();
                        if (!t) return;
                        setManualPreview(applyFxSwap(scenario, t));
                      }}
                      className="px-4 py-3 rounded-2xl text-sm font-bold border border-slate-200 bg-white hover:bg-slate-50 transition text-slate-900"
                    >
                      Preview
                    </button>

                    <button onClick={() => setManualPreview(null)} className="px-4 py-3 rounded-2xl text-sm font-bold border border-slate-200 bg-white hover:bg-slate-50 transition text-slate-900">
                      Clear manual preview
                    </button>
                  </>
                ) : null}

                <button
                  onClick={() => {
                    const t = buildTradeFromManual();
                    if (!t) return;
                    setScenario((s) => applyFxSwap(s, t));
                    logTrade(t, { mode: "manual" });
                    setManualPreview(null);
                  }}
                  className="px-4 py-3 rounded-2xl text-sm font-bold bg-slate-900 text-white hover:bg-slate-800 transition"
                >
                  Execute
                </button>
              </div>
            </div>

            {costPanel}
            <div>{fxRatesPanel}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
