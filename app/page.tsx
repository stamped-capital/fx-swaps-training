"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * FX Swaps Training Tool — Single-file Page (Next.js App Router)
 *
 * Tabs:
 * - Home: overview + how to use
 * - Basic: one random swap suggestion; user chooses Execute or Reject (test mode)
 * - Guided: 8 tiles (good/marginal/bad), includes CROSS pairs
 * - Manual: swap entry UI with 4-leg boxes; shared scenario state so blotter stays in sync
 *
 * Blotter is CASHFLOW style:
 * - t+0: cash at bank (balance)
 * - t+1..t+14: net cashflow on that date (seeded + swaps executed)
 *
 * Roll:
 * - t+0 stays as cash at bank
 * - t+1 cashflows net into t+0, horizon shifts
 *
 * Objective:
 * - Square all NON-USD t+0 balances within ±5m (USD exempt)
 *
 * Constraints:
 * - For each currency, the SUM across the whole row (t0 + all future flows) is forced into (0..10m),
 *   except USD which is forced to be >= 300m. (Enforced at scenario generation + roll.)
 *
 * Cost tracker:
 * - Logs each executed swap with USD carry approx (most recent first)
 * - Shows running total for the day
 * - Where the time used to be, now shows the USD carry for that trade.
 *
 * Basic tab behavior:
 * - Near leg always t+0
 * - Suggestion can be any pair (crosses allowed)
 * - Correct choice:
 *    - Execute if swap improves toward objective
 *    - Reject if swap worsens
 * - Wrong choice:
 *    - swap is executed anyway
 *    - overlay: "Incorrect - review blotter to see what this would do to your positions"
 *    - changed blotter cells get yellow ring AND show "prev." with the previous amount
 *    - "Undo & Next" button is prominent and red; undo reverts last swap then shows next suggestion
 *
 * Basic difficulty:
 * - Suggestions are generated to be ~50/50 good vs bad (challenging).
 */

type Ccy = string;
const CCYS: Ccy[] = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK"];

const HORIZON = 15; // t+0..t+14
const MAX_DAYS = 80;

const URGENT = 50_000_000;
const TOL = 5_000_000;

const USD_MIN_ROW_TOTAL = 300_000_000;
const NONUSD_ROW_TOTAL_MIN = 1;
const NONUSD_ROW_TOTAL_MAX = 10_000_000;

const USD_BASE_LONG = 300_000_000;
const GUIDED_STEPS_PER_DAY = 10;

const IR: Record<Ccy, number> = {
  USD: 0.05,
  EUR: 0.035,
  GBP: 0.052,
  JPY: 0.005,
  CHF: 0.02,
  CAD: 0.047,
  AUD: 0.044,
  NZD: 0.05,
  SEK: 0.035,
  NOK: 0.045,
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

function forwardFromSpot(spot: number, buyCcy: Ccy, sellCcy: Ccy, days: number) {
  const T = clamp(days, 0, 3650) / 360;
  const rb = IR[buyCcy] ?? 0.03;
  const rs = IR[sellCcy] ?? 0.03;
  return (spot * (1 + rs * T)) / (1 + rb * T);
}

type SwapTrade = {
  buyCcy: Ccy;
  sellCcy: Ccy;
  notionalBuy: number;
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

/* ----------------------------- Objective helpers ----------------------------- */

function nonUsdSquaredAtT0(bal: Record<Ccy, number>) {
  for (const c of CCYS) {
    if (c === "USD") continue;
    if (Math.abs(bal[c] ?? 0) > TOL) return false;
  }
  return true;
}

function t0ErrorL1(bal: Record<Ccy, number>) {
  let e = 0;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const v = Math.abs(bal[c] ?? 0);
    if (v > TOL) e += v - TOL;
  }
  return e;
}

/* ----------------------------- Scenario generation ----------------------------- */

function generateGuidedSolvableScenario(): Scenario {
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

  const nonUsd = CCYS.filter((c) => c !== "USD");
  const offCount = Math.floor(rand(6, 9));
  const off = [...nonUsd].sort(() => Math.random() - 0.5).slice(0, offCount);
  const nearZero = nonUsd.filter((c) => !off.includes(c));

  for (const c of nearZero) balances[c] = Math.round(rand(-4_000_000, 4_000_000));
  for (const c of off) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const mag = Math.round(rand(20_000_000, 95_000_000) / 1_000_000) * 1_000_000;
    balances[c] = sign * mag;
  }

  return enforceRowTotals({ balances, flows });
}

/* ----------------------------- Guided ----------------------------- */

type GuidedTile = SwapTrade & {
  id: string;
  category: "Best" | "Marginal" | "Worse";
  scoreDelta: 10 | 5 | -5;
  why: string;
  usdCost: number | null;
};

function pickWorstNonUsdBalance(bal: Record<Ccy, number>) {
  let worstCcy: Ccy | null = null;
  let worstAbs = -1;
  let value = 0;
  for (const c of CCYS) {
    if (c === "USD") continue;
    const v = bal[c] ?? 0;
    const a = Math.abs(v);
    if (a > worstAbs) {
      worstAbs = a;
      worstCcy = c;
      value = v;
    }
  }
  return { ccy: worstCcy, value };
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
    return {
      id: id(),
      buyCcy,
      sellCcy,
      notionalBuy: Math.round(notionalBuy),
      nearOffset,
      farOffset,
      spot: sp,
      fwd: fw,
      category,
      scoreDelta,
      why,
      usdCost: Number.isFinite(usdC) ? usdC : null,
    };
  };
}

function generateGuidedTiles(s: Scenario, rates: UsdRates): GuidedTile[] {
  const makeTile = makeTileFactory(rates);

  const bal = s.balances;
  const worst = pickWorstNonUsdBalance(bal);
  const worstCcy = worst.ccy ?? "EUR";
  const worstVal = worst.value;

  const nonUsd = CCYS.filter((c) => c !== "USD");
  const sorted = nonUsd
    .map((c) => ({ c, a: Math.abs(bal[c] ?? 0), v: bal[c] ?? 0 }))
    .sort((a, b) => b.a - a.a);

  const second = sorted[1]?.c ?? pickOne(nonUsd.filter((c) => c !== worstCcy));
  const secondVal = bal[second] ?? 0;

  const oppositeSignPartner = (ccy: Ccy) => {
    const v = bal[ccy] ?? 0;
    const candidates = nonUsd
      .filter((x) => x !== ccy)
      .map((x) => ({ x, vx: bal[x] ?? 0, ax: Math.abs(bal[x] ?? 0) }))
      .filter((o) => (v >= 0 ? o.vx < 0 : o.vx > 0))
      .sort((a, b) => b.ax - a.ax);
    return candidates[0]?.x ?? "USD";
  };

  const near = 0;
  const farSolve = 2;

  const need = Math.max(0, Math.abs(worstVal) - TOL);
  const fixNotional = clamp(need, 8_000_000, 110_000_000);
  const partner1 = Math.random() < 0.55 ? "USD" : oppositeSignPartner(worstCcy);

  let best1: GuidedTile;
  if (worstVal < 0) {
    best1 = makeTile(
      worstCcy,
      partner1,
      fixNotional,
      near,
      farSolve,
      "Best",
      10,
      partner1 === "USD"
        ? `Targets t+0: buys ${worstCcy} to reduce today's short toward ±5m. Far leg on t+2.`
        : `Cross: buys ${worstCcy} funded by selling ${partner1} to reduce both imbalances. Far leg on t+2.`
    );
  } else {
    const sp = spotFromUsdRates(partner1, worstCcy, rates) ?? 1;
    const partnerNotional = fixNotional / sp;
    best1 = makeTile(
      partner1,
      worstCcy,
      partnerNotional,
      near,
      farSolve,
      "Best",
      10,
      partner1 === "USD"
        ? `Targets t+0: reduces today's long ${worstCcy} toward ±5m by selling ${worstCcy}. Far leg on t+2.`
        : `Cross: reduces ${worstCcy} long by selling ${worstCcy} vs buying ${partner1}. Far leg on t+2.`
    );
  }

  const farFuture = pickOne([7, 10, 14]);
  const need2 = Math.max(0, Math.abs(secondVal) - TOL);
  const fix2 = clamp(need2 * 0.75, 6_000_000, 90_000_000);
  const partner2 = Math.random() < 0.55 ? "USD" : oppositeSignPartner(second);

  let best2: GuidedTile;
  if (secondVal < 0) {
    best2 = makeTile(
      second,
      partner2,
      fix2,
      0,
      farFuture,
      "Best",
      10,
      partner2 === "USD"
        ? `Future netting: adds ${second} today and offsets at t+${farFuture}.`
        : `Cross future netting: buys ${second} vs selling ${partner2}; offset pushed to t+${farFuture}.`
    );
  } else {
    const sp = spotFromUsdRates(partner2, second, rates) ?? 1;
    best2 = makeTile(
      partner2,
      second,
      fix2 / sp,
      0,
      farFuture,
      "Best",
      10,
      partner2 === "USD"
        ? `Future netting: reduces long ${second} today while pushing the offset to t+${farFuture}.`
        : `Cross: reduces ${second} long by selling it vs buying ${partner2}; offset at t+${farFuture}.`
    );
  }

  const marginals: GuidedTile[] = [];
  const worses: GuidedTile[] = [];

  const randomPair = () => {
    const buy = pickOne(CCYS);
    let sell = pickOne(CCYS);
    if (sell === buy) sell = pickOne(CCYS.filter((x) => x !== buy));
    return { buy, sell };
  };

  for (let i = 0; i < 3; i++) {
    const c = pickOne(nonUsd);
    const v = bal[c] ?? 0;
    const far = pickOne([2, 3, 5, 7]);
    const n = i < 2 ? 0 : pickOne([0, 1]);
    const mag = clamp(Math.max(0, Math.abs(v) - TOL) * rand(0.25, 0.6), 4_000_000, 60_000_000);

    const useCross = Math.random() < 0.5;
    const partner = useCross ? oppositeSignPartner(c) : "USD";

    if (v < 0) {
      marginals.push(
        makeTile(
          c,
          partner,
          mag,
          n,
          far,
          "Marginal",
          5,
          partner === "USD"
            ? `Marginal: helps ${c} but leaves residual imbalance or shifts risk to other tenors.`
            : `Marginal cross: buys ${c} vs selling ${partner}; helps, but not globally optimal.`
        )
      );
    } else {
      const sp = spotFromUsdRates(partner, c, rates) ?? 1;
      marginals.push(
        makeTile(
          partner,
          c,
          mag / sp,
          n,
          far,
          "Marginal",
          5,
          partner === "USD"
            ? `Marginal: partially reduces ${c} long but isn’t globally optimal.`
            : `Marginal cross: reduces ${c} long via ${partner}/${c}, but leaves other risk.`
        )
      );
    }
  }

  for (let i = 0; i < 3; i++) {
    const { buy, sell } = randomPair();
    const far = pickOne([2, 3, 5, 7, 10]);
    const n = i < 2 ? 0 : pickOne([0, 1]);
    const mag = Math.round(rand(10_000_000, 70_000_000) / 1_000_000) * 1_000_000;

    worses.push(
      makeTile(buy, sell, mag, n, far, "Worse", -5, `Worse: random swap ${buy}/${sell} likely to worsen today's t+0.`)
    );
  }

  return [best1, best2, ...marginals, ...worses].slice(0, 8).sort(() => Math.random() - 0.5);
}

/* ----------------------------- Basic (single-suggestion) ----------------------------- */

type BasicSuggestion = SwapTrade & {
  id: string;
  isGood: boolean;
  usdCost: number | null;
};

function buildGoodBasicSwap(s: Scenario, rates: UsdRates): SwapTrade | null {
  const nearOffset = 0;
  const farOffset = Math.random() < 0.75 ? 2 : pickOne([3, 5, 7]);

  const bal = s.balances;
  const nonUsd = CCYS.filter((c) => c !== "USD");
  const worst = pickWorstNonUsdBalance(bal);
  const c = worst.ccy;
  if (!c) return null;

  const v = bal[c] ?? 0;
  if (Math.abs(v) <= TOL) {
    const sorted = nonUsd
      .map((x) => ({ x, a: Math.abs(bal[x] ?? 0), v: bal[x] ?? 0 }))
      .sort((a, b) => b.a - a.a);
    const pick = sorted.find((z) => z.a > TOL);
    if (!pick) return null;
    return buildGoodBasicSwap({ ...s }, rates);
  }

  const partner = (() => {
    const candidates = nonUsd
      .filter((x) => x !== c)
      .map((x) => ({ x, vx: bal[x] ?? 0, ax: Math.abs(bal[x] ?? 0) }))
      .filter((o) => (v >= 0 ? o.vx < 0 : o.vx > 0))
      .sort((a, b) => b.ax - a.ax);
    return candidates[0]?.x ?? "USD";
  })();

  const need = Math.max(0, Math.abs(v) - TOL);
  const chunk = clamp(need * rand(0.45, 0.85), 12_000_000, 120_000_000);

  let buyCcy: Ccy;
  let sellCcy: Ccy;
  let notionalBuy: number;

  if (v < 0) {
    buyCcy = c;
    sellCcy = partner;
    notionalBuy = chunk;
  } else {
    buyCcy = partner;
    sellCcy = c;
    const sp = spotFromUsdRates(buyCcy, sellCcy, rates);
    if (!sp) return null;
    notionalBuy = chunk / sp;
  }

  const sp = spotFromUsdRates(buyCcy, sellCcy, rates);
  if (!sp) return null;
  const fw = forwardFromSpot(sp, buyCcy, sellCcy, Math.max(1, farOffset - nearOffset));

  return {
    buyCcy,
    sellCcy,
    notionalBuy: Math.round(notionalBuy),
    nearOffset,
    farOffset,
    spot: sp,
    fwd: fw,
  };
}

function buildBadBasicSwap(s: Scenario, rates: UsdRates): SwapTrade | null {
  const good = buildGoodBasicSwap(s, rates);
  if (good) {
    const buy = good.sellCcy;
    const sell = good.buyCcy;
    const sp = spotFromUsdRates(buy, sell, rates);
    if (!sp) return null;
    const fw = forwardFromSpot(sp, buy, sell, Math.max(1, good.farOffset - good.nearOffset));
    return {
      buyCcy: buy,
      sellCcy: sell,
      notionalBuy: good.notionalBuy,
      nearOffset: 0,
      farOffset: good.farOffset,
      spot: sp,
      fwd: fw,
    };
  }

  const nearOffset = 0;
  const farOffset = pickOne([2, 3, 5, 7]);
  const buy = pickOne(CCYS);
  let sell = pickOne(CCYS);
  if (sell === buy) sell = pickOne(CCYS.filter((x) => x !== buy));

  const sp = spotFromUsdRates(buy, sell, rates) ?? 1;
  const fw = forwardFromSpot(sp, buy, sell, Math.max(1, farOffset - nearOffset));
  const notionalBuy = Math.round(rand(15_000_000, 90_000_000));

  return { buyCcy: buy, sellCcy: sell, notionalBuy, nearOffset, farOffset, spot: sp, fwd: fw };
}

function buildBasicSuggestion(s: Scenario, rates: UsdRates): BasicSuggestion {
  // 50/50 mix of swaps that (by construction) tend to help vs harm.
  const wantGood = Math.random() < 0.5;
  const t = (wantGood ? buildGoodBasicSwap(s, rates) : buildBadBasicSwap(s, rates)) ?? buildBadBasicSwap(s, rates)!;

  const after = applyFxSwap(s, t);
  const isGood = t0ErrorL1(after.balances) < t0ErrorL1(s.balances);

  const usdC = swapUsdCost({ notionalBuy: t.notionalBuy, spot: t.spot, fwd: t.fwd, sellCcy: t.sellCcy }, rates);

  return {
    id: id(),
    ...t,
    isGood,
    usdCost: Number.isFinite(usdC) ? usdC : null,
  };
}

/* ----------------------------- UI ----------------------------- */

type Tab = "home" | "basic" | "guided" | "manual";

function TabButton({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={classNames(
        "px-4 py-2 rounded-xl text-sm font-semibold border transition",
        active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-900 border-slate-200 hover:bg-slate-50"
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
      <div className="text-sm text-slate-900 font-semibold">
        Blotter shows net cashflows by day. t+0 is cash at bank plus executed trades.
      </div>
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
                    className={classNames(
                      "p-3 text-right tabular-nums transition",
                      cellClass(v),
                      hi ? "ring-2 ring-yellow-400 ring-inset" : ""
                    )}
                  >
                    <div className="font-semibold">{formatM(v)}</div>
                    {hi && typeof pv === "number" ? (
                      <div className="text-[11px] font-bold text-slate-700 mt-1">prev. {formatM(pv)}</div>
                    ) : null}
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

/* ----------------------------- Page ----------------------------- */

type TradeLogItem = {
  id: string;
  label: string;
  usdCost: number | null;
  timestamp: number;
  correct?: boolean;
  mode?: "basic" | "guided" | "manual";
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
  const [scenario, setScenario] = useState<Scenario>(() => generateGuidedSolvableScenario());

  // Trade log
  const [tradeLog, setTradeLog] = useState<TradeLogItem[]>([]);
  const totalCost = useMemo(() => {
    let t = 0;
    for (const x of tradeLog) if (Number.isFinite(x.usdCost as any)) t += x.usdCost as number;
    return t;
  }, [tradeLog]);

  function logTrade(t: SwapTrade, correct?: boolean, mode?: TradeLogItem["mode"]) {
    const usdC =
      ratesRef.current.status === "ok"
        ? swapUsdCost({ notionalBuy: t.notionalBuy, spot: t.spot, fwd: t.fwd, sellCcy: t.sellCcy }, ratesRef.current)
        : NaN;

    setTradeLog((prev) => [
      {
        id: id(),
        label: `Buy ${t.buyCcy} / Sell ${t.sellCcy} · ${formatM(t.notionalBuy)} ${t.buyCcy}`,
        usdCost: Number.isFinite(usdC) ? usdC : null,
        timestamp: Date.now(),
        correct,
        mode,
      },
      ...prev,
    ]);
  }

  // Basic score counter (correct out of attempts)
  const basicAttempts = useMemo(() => tradeLog.filter((x) => x.mode === "basic" && typeof x.correct === "boolean"), [tradeLog]);
  const basicCorrect = useMemo(() => basicAttempts.filter((x) => x.correct).length, [basicAttempts]);
  const basicTotal = basicAttempts.length;

  // Guided state
  const [guidedStep, setGuidedStep] = useState(0);
  const [guidedScore, setGuidedScore] = useState(0);
  const [guidedTiles, setGuidedTiles] = useState<GuidedTile[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<GuidedTile | null>(null);
  const [previewScenario, setPreviewScenario] = useState<Scenario | null>(null);

  const swapsLeft = GUIDED_STEPS_PER_DAY - guidedStep;

  useEffect(() => {
    if (rates.status !== "ok") return;
    setGuidedTiles(generateGuidedTiles(scenario, rates));
    setPreviewScenario(null);
    setSelected(null);
    setRevealed(new Set());
  }, [scenario, rates.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function previewGuided(t: GuidedTile) {
    if (!previewEnabled) return;
    setPreviewScenario(applyFxSwap(scenario, t));
  }
  function clearPreview() {
    setPreviewScenario(null);
    setManualPreview(null);
  }

  function executeGuided(t: GuidedTile) {
    const after = applyFxSwap(scenario, t);
    setScenario(after);

    setRevealed((prev) => {
      const n = new Set(prev);
      n.add(t.id);
      return n;
    });
    setSelected(t);
    setGuidedScore((x) => clamp(x + t.scoreDelta, 0, 100));
    logTrade(t, true, "guided");

    setGuidedStep((x) => x + 1);
    setPreviewScenario(null);
  }

  // Basic state
  const [basicSuggestion, setBasicSuggestion] = useState<BasicSuggestion | null>(null);
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

  useEffect(() => {
    if (rates.status !== "ok") return;
    if (!basicIncorrect.active) setBasicSuggestion(buildBasicSuggestion(scenario, rates));
  }, [rates.status, scenario, basicIncorrect.active]); // eslint-disable-line react-hooks/exhaustive-deps

  function basicChoose(action: "execute" | "reject") {
    if (!basicSuggestion || ratesRef.current.status !== "ok") return;

    const s0 = scenario;
    const beforeErr = t0ErrorL1(s0.balances);
    const afterScenario = applyFxSwap(s0, basicSuggestion);
    const afterErr = t0ErrorL1(afterScenario.balances);
    const improves = afterErr < beforeErr;

    const correct = action === "execute" ? improves : !improves;

    if (correct) {
      if (action === "execute") {
        setScenario(afterScenario);
        logTrade(basicSuggestion, true, "basic");
      } else {
        // Reject was correct: log a "virtual" correct decision without applying trade.
        // We still log with 0-cost and a tiny notional just for scoring? Prefer: log no trade.
        // But you wanted "how many out of total shown got correct" — so log it with carry = 0.
        logTrade(
          { ...basicSuggestion, notionalBuy: 0 },
          true,
          "basic"
        );
      }

      setBasicIncorrect({ active: false });
      setBasicSuggestion(buildBasicSuggestion(action === "execute" ? afterScenario : s0, ratesRef.current));
      return;
    }

    // Wrong: execute anyway, show changed cells with prev values, allow undo
    const { changed, prev } = diffCellsAndPrev(s0, afterScenario);
    setScenario(afterScenario);
    logTrade(basicSuggestion, false, "basic");
    setBasicIncorrect({ active: true, lastScenarioBefore: s0, changedCells: changed, prevValues: prev });
  }

  function basicUndoAndNext() {
    if (!basicIncorrect.active || !basicIncorrect.lastScenarioBefore || ratesRef.current.status !== "ok") return;
    const restored = basicIncorrect.lastScenarioBefore;
    setScenario(restored);
    setBasicIncorrect({ active: false });
    setBasicSuggestion(buildBasicSuggestion(restored, ratesRef.current));
  }

  // Manual swap entry
  const [mBuy, setMBuy] = useState<Ccy>("EUR");
  const [mSell, setMSell] = useState<Ccy>("USD");
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

  useEffect(() => {
    if (ratesRef.current.status !== "ok") return;
    if (mBuy === mSell) return;

    const sp = spotFromUsdRates(mBuy, mSell, ratesRef.current);
    if (!sp) return;
    const fw = forwardFromSpot(sp, mBuy, mSell, Math.max(1, mFar - mNear));

    const computeFromNotionalBuy = (nBuy: number) => {
      const nearBuy = nBuy;
      const nearSell = -Math.round(nBuy * sp);
      const farBuy = -nBuy;
      const farSell = +Math.round(nBuy * fw);

      setNearSellStr(formatWithCommasDigitsOnly(String(Math.abs(nearSell))) ? `-${formatWithCommasDigitsOnly(String(Math.abs(nearSell)))}` : "");
      setFarBuyStr(formatWithCommasDigitsOnly(String(Math.abs(farBuy))) ? `-${formatWithCommasDigitsOnly(String(Math.abs(farBuy)))}` : "");
      setFarSellStr(formatWithCommasDigitsOnly(String(Math.abs(farSell))) ? `+${formatWithCommasDigitsOnly(String(Math.abs(farSell)))}` : "");
      setNearBuyStr(formatWithCommasDigitsOnly(String(Math.abs(nearBuy))) ? `${formatWithCommasDigitsOnly(String(Math.abs(nearBuy)))}` : "");
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
  }, [mBuy, mSell, mNear, mFar, activeField, nearBuyStr, nearSellStr, farBuyStr, farSellStr, rates.status]);

  function buildTradeFromManual(): SwapTrade | null {
    if (ratesRef.current.status !== "ok") return null;
    if (mBuy === mSell) return null;

    const nBuy = parseCommaNumber(nearBuyStr);
    if (!Number.isFinite(nBuy) || nBuy <= 0) return null;

    const sp = spotFromUsdRates(mBuy, mSell, ratesRef.current);
    if (!sp) return null;
    const fw = forwardFromSpot(sp, mBuy, mSell, Math.max(1, mFar - mNear));

    return {
      buyCcy: mBuy,
      sellCcy: mSell,
      notionalBuy: Math.round(nBuy),
      nearOffset: mNear,
      farOffset: mFar,
      spot: sp,
      fwd: fw,
    };
  }

  function resetAll() {
    const s = generateGuidedSolvableScenario();
    setScenario(s);
    setDayNumber(1);
    setTradeLog([]);

    setGuidedStep(0);
    setGuidedScore(0);
    setGuidedTiles([]);
    setRevealed(new Set());
    setSelected(null);
    setPreviewScenario(null);

    setBasicIncorrect({ active: false });
    if (ratesRef.current.status === "ok") setBasicSuggestion(buildBasicSuggestion(s, ratesRef.current));
    else setBasicSuggestion(null);

    setManualPreview(null);

    setMBuy("EUR");
    setMSell("USD");
    setMNear(0);
    setMFar(2);
    setActiveField("nearBuy");
    setNearBuyStr("25,000,000");
  }

  function rollDay() {
    setScenario((s) => rollValueDate(s));
    setDayNumber((d) => d + 1);
    setTradeLog([]);

    setGuidedStep(0);
    setGuidedScore(0);
    setSelected(null);
    setPreviewScenario(null);
    setRevealed(new Set());

    setBasicIncorrect({ active: false });
    setManualPreview(null);
  }

  const displayScenario = tab === "guided" ? previewScenario ?? scenario : tab === "manual" ? manualPreview ?? scenario : scenario;

  const solvedNow = useMemo(() => nonUsdSquaredAtT0(scenario.balances), [scenario]);
  const guidedSolved = useMemo(() => nonUsdSquaredAtT0((previewScenario ?? scenario).balances), [scenario, previewScenario]);

  const objectiveBanner = (
    <>
      <div className="text-sm font-semibold text-slate-900">
        Objective: square all <span className="font-bold">non-USD</span> <span className="font-bold">t+0</span> balances to within{" "}
        <span className="font-bold">±5m</span>. USD is exempt.
      </div>
      <div className="text-sm font-semibold text-slate-900">
        t+1..t+14 columns show <span className="font-bold">net cashflow</span> for that date (seeded trades + your swaps), not a predicted balance.
      </div>
    </>
  );

  const ratesList = useMemo(() => {
    const items = CCYS.map((c) => ({ ccy: c, cPerUsd: rates.ccyPerUsd[c], usdPerC: rates.usdPerCcy[c] }));
    return items.sort((a, b) => (a.ccy === "USD" ? -1 : b.ccy === "USD" ? 1 : a.ccy.localeCompare(b.ccy)));
  }, [rates]);

  const costPanel = (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Pill label="Day total USD cost/gain" value={`$${formatInt(totalCost)}`} />
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
          <div className="text-sm font-bold text-slate-900">Running total</div>
          <div className="ml-auto text-sm font-bold text-slate-900">${formatInt(totalCost)}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto p-6 pb-24 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <div className="text-2xl font-semibold text-slate-900">Remitly Treasury</div>
            <h1 className="text-2xl font-semibold text-slate-900">FRD Book Management 101</h1>
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
                previewEnabled ? "bg-slate-900 text-white border-slate-900 hover:bg-slate-800" : "bg-white text-slate-900 border-slate-200 hover:bg-slate-50"
              )}
              title="When OFF, hides preview controls (Guided/Manual)."
            >
              Preview: {previewEnabled ? "On" : "Off"}
            </button>

            <button
              onClick={resetAll}
              className="px-4 py-2 rounded-xl text-sm font-semibold border border-slate-200 bg-white hover:bg-slate-50 transition text-slate-900"
            >
              Reset
            </button>

            <button
              onClick={rollDay}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800 transition rounded-xl"
              title="Roll value date (nets t+1 into t+0 and shifts horizon)."
            >
              Roll Day
            </button>
          </div>
        </div>

        <Banner dayNumber={dayNumber} />

        {/* HOME */}
        {tab === "home" ? (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
              <div className="text-xl font-extrabold text-slate-900">What this tool is</div>
              <p className="mt-3 text-sm font-semibold text-slate-800 leading-relaxed">
                This simulator is a hands-on training tool for learning how FX swaps change cash positions over a rolling value-date horizon.
                The blotter is shown in “cashflow view”: <span className="font-bold">t+0 is cash at bank plus executed trades</span>, and <span className="font-bold">t+1..t+14</span> are
                net cashflows expected on those dates. Every swap you execute updates the blotter so you can build intuition on how near/far legs
                reshape today’s positions and future liquidity.
              </p>

              <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-sm font-extrabold text-slate-900">Your objective</div>
                  <ul className="mt-2 list-disc ml-5 text-sm font-semibold text-slate-800 space-y-1">
                    <li>
                      Square all <span className="font-bold">non-USD</span> <span className="font-bold">t+0</span> balances within <span className="font-bold">±5m</span>.
                    </li>
                    <li>USD is exempt (but remains large and positive).</li>
                    <li>Use swaps to shift exposures between currencies and across time.</li>
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
                      Graduate to <span className="font-bold">Manual</span>: you build swaps yourself using a trader style entry.
                    </li>
                  </ul>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-extrabold text-slate-900">Basic tab</div>
                  <div className="mt-2 text-sm font-semibold text-slate-800">
                    You’re shown one swap at a time. Decide whether executing it improves squaring at <span className="font-bold">t+0</span>.
                    If you’re wrong, the swap applies as a penalty, and the blotter highlights what changed.
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-extrabold text-slate-900">Guided tab</div>
                  <div className="mt-2 text-sm font-semibold text-slate-800">
                    Multiple swaps are offered, mixing good, marginal, and worse options (including crosses). Execute swaps to drive non-USD t+0
                    into range while watching cost/gain.
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-sm font-extrabold text-slate-900">Manual tab</div>
                  <div className="mt-2 text-sm font-semibold text-slate-800">
                    Use the trade entry ticket. Change any one box and the others auto-calc. This is the most realistic mode and will prepare you to trade live in-market.
                  </div>
                </div>
              </div>

              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-extrabold text-slate-900">Preview toggle & cost tracker</div>
                <ul className="mt-2 list-disc ml-5 text-sm font-semibold text-slate-800 space-y-1">
                  <li>
                    <span className="font-bold">Preview toggle</span>: when ON, Guided/Manual can preview how a swap would change the blotter without committing it.
                    When OFF, preview controls are hidden to increase difficulty.
                  </li>
                  <li>
                    <span className="font-bold">Cost tracker</span>: logs each executed swap with an approximate USD carry and shows a running total for the day.
                  </li>
                </ul>
              </div>
            </div>

            <div className="space-y-2">
              <Blotter scenario={scenario} />
              {objectiveBanner}
            </div>

            {costPanel}
          </div>
        ) : null}

        {/* Blotter (all non-home tabs) */}
        {tab !== "home" ? (
          <div className="space-y-2">
            <Blotter
              scenario={displayScenario}
              highlightCells={tab === "basic" ? basicIncorrect.changedCells : undefined}
              prevValues={tab === "basic" ? basicIncorrect.prevValues : undefined}
            />
            {objectiveBanner}
          </div>
        ) : null}

        {/* BASIC */}
        {tab === "basic" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Pill label="Solved (current state)" value={solvedNow ? "✅ Yes" : "No"} />
              <Pill label="Day total cost/gain" value={`$${formatInt(totalCost)}`} />
              <Pill label="Basic accuracy" value={`${basicCorrect} / ${basicTotal}`} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="text-sm font-semibold text-slate-900">
                  Decide whether to <span className="font-bold">Execute</span> or <span className="font-bold">Reject</span> based on what it does to{" "}
                  <span className="font-bold">t+0</span> squaring.
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
                        Notional: {formatM(basicSuggestion.notionalBuy)} {basicSuggestion.buyCcy}
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
                          <button
                            onClick={basicUndoAndNext}
                            className="px-5 py-3 rounded-2xl text-sm font-extrabold bg-rose-600 text-white hover:bg-rose-700 transition shadow-sm"
                          >
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
                      {rates.status === "loading" ? "Loading rates…" : rates.status === "error" ? `Rates error: ${rates.error}` : "No suggestion."}
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
          </div>
        ) : null}

        {/* GUIDED */}
        {tab === "guided" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Pill label="Swaps left" value={swapsLeft} />
              <Pill label="Score (out of 100)" value={guidedScore} />
              <Pill label="Day total cost/gain" value={`$${formatInt(totalCost)}`} />
              {guidedSolved ? (
                <div className="px-4 py-3 rounded-2xl bg-emerald-100 text-emerald-900 font-bold text-sm border border-emerald-200">
                  ✅ Solved (non-USD t+0 within ±5m)
                </div>
              ) : null}
            </div>

            <div className="text-lg font-semibold text-slate-900">Choose an FX swap (USD + crosses)</div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {guidedTiles.map((t) => (
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
                        Near: t+{t.nearOffset} · Far: t+{t.farOffset}
                      </div>
                      <div className="text-xs text-slate-900 font-semibold mt-1">
                        USD carry (approx): {t.usdCost === null ? "—" : `$${formatInt(t.usdCost)}`}
                      </div>
                    </div>
                    {revealed.has(t.id) ? (
                      <div
                        className={classNames(
                          "text-xs px-2 py-1 rounded-lg font-semibold",
                          t.category === "Best"
                            ? "bg-emerald-100 text-emerald-900"
                            : t.category === "Marginal"
                            ? "bg-amber-100 text-amber-900"
                            : "bg-rose-100 text-rose-900"
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
                      className={classNames(
                        "px-3 py-2 rounded-xl text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800 transition",
                        previewEnabled ? "flex-1" : "w-full"
                      )}
                    >
                      Execute
                    </button>
                  </div>

                  {revealed.has(t.id) ? <div className="text-sm font-semibold text-slate-900">{t.why}</div> : null}
                </div>
              ))}
            </div>

            {selected ? (
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
                <div className="text-sm font-semibold text-slate-900">Last trade</div>
                <div className="text-lg font-bold text-slate-900 mt-1">
                  Buy {selected.buyCcy} / Sell {selected.sellCcy} · Near t+{selected.nearOffset} · Far t+{selected.farOffset}
                </div>
                <div className="text-sm font-semibold text-slate-900 mt-2">{selected.why}</div>
                <div className="text-sm font-semibold text-slate-900 mt-2">
                  Total cost/gain today: <span className="font-bold">${formatInt(totalCost)}</span>
                </div>
              </div>
            ) : null}

            {costPanel}
          </div>
        ) : null}

        {/* MANUAL */}
        {tab === "manual" ? (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-slate-900">Manual swap entry</div>
                  <div className="text-sm font-semibold text-slate-900 mt-1">
                    Edit any one box and the rest auto-calc.
                  </div>
                </div>
                <div className="text-sm font-bold text-slate-900">
                  Day cost/gain: <span className="font-extrabold">${formatInt(totalCost)}</span>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Buy currency</div>
                  <select
                    value={mBuy}
                    onChange={(e) => setMBuy(e.target.value)}
                    className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                  >
                    {CCYS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Sell currency</div>
                  <select
                    value={mSell}
                    onChange={(e) => setMSell(e.target.value)}
                    className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                  >
                    {CCYS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {mSell === mBuy ? <div className="text-xs font-bold text-rose-700 mt-2">Buy and Sell must differ.</div> : null}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Near</div>
                  <select
                    value={mNear}
                    onChange={(e) => setMNear(Number(e.target.value))}
                    className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                  >
                    {Array.from({ length: HORIZON }, (_, i) => i).map((t) => (
                      <option key={t} value={t}>
                        t+{t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Far</div>
                  <select
                    value={mFar}
                    onChange={(e) => setMFar(Number(e.target.value))}
                    className="mt-2 w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-900 font-semibold"
                  >
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

              {/* 4-box legs */}
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Near Buy (+ {mBuy})</div>
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
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Near Sell (- {mSell})</div>
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

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Far Buy (- {mBuy})</div>
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

                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-700 font-bold">Far Sell (+ {mSell})</div>
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

                    <button
                      onClick={() => setManualPreview(null)}
                      className="px-4 py-3 rounded-2xl text-sm font-bold border border-slate-200 bg-white hover:bg-slate-50 transition text-slate-900"
                    >
                      Clear manual preview
                    </button>
                  </>
                ) : null}

                <button
                  onClick={() => {
                    const t = buildTradeFromManual();
                    if (!t) return;
                    setScenario((s) => applyFxSwap(s, t));
                    logTrade(t, undefined, "manual");
                    setManualPreview(null);
                  }}
                  className="px-4 py-3 rounded-2xl text-sm font-bold bg-slate-900 text-white hover:bg-slate-800 transition"
                >
                  Execute
                </button>

                <div className="ml-auto text-sm font-semibold text-slate-700">
                  {rates.status === "ok" ? (
                    <>
                      Spot (sell per buy):{" "}
                      <span className="font-bold text-slate-900 ml-1">
                        {(() => {
                          const sp = spotFromUsdRates(mBuy, mSell, rates);
                          return sp ? sp.toFixed(6) : "—";
                        })()}
                      </span>
                    </>
                  ) : (
                    <span>Rates: {rates.status === "loading" ? "Loading…" : "Error"}</span>
                  )}
                </div>
              </div>
            </div>

            {costPanel}
          </div>
        ) : null}

        {/* Rates */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
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

          <div className="h-6" />
          <div className="text-xs font-semibold text-slate-700">Note: Carry is a simplified interest-differential approximation using static IR assumptions.</div>
        </div>
      </div>
    </div>
  );
}
