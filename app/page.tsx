"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Mode = "basic" | "guided";

type Option = {
  id: string;
  label: string;
  // Lower is better (e.g., USD cost)
  cost: number;
};

type Execution = {
  id: string;
  pair: string; // e.g. "EURUSD"
  valueDate: string; // display only
  prompt: string;
  options: Option[];
  bestOptionId: string; // the single best option
  // "Marginal" options are still "correct" in guided scoring but not best.
  marginalOptionIds: string[];
};

type DayScenario = {
  dayIndex: number; // 1-based for display
  valueDateLabel: string;
  rateMatrix: { pair: string; bid: number; ask: number }[];
  blotterRows: { ccy: string; amount: number }[];
  notes: string[];
  executions: Execution[];
};

type PickResult = {
  executionId: string;
  pickedOptionId: string;
  isBest: boolean;
  isMarginal: boolean;
  isCorrectBasic: boolean;
  isCorrectGuided: boolean;
  cost: number;
};

type DayPerformance = {
  dayIndex: number;
  correct: number;
  total: number;
  marginalCorrect: number;
  bestCorrect: number;
  actualCost: number;
  bestPossibleCost: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatMoney(n: number) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

function formatPct(n: number) {
  return `${(n * 100).toFixed(0)}%`;
}

function formatScore(correct: number, total: number) {
  return `${correct}/${total}`;
}

// Simple deterministic-ish shuffle (seeded by dayIndex + executionId)
function seededShuffle<T>(arr: T[], seed: number) {
  const a = [...arr];
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sumBestPossibleCost(execs: Execution[]) {
  return execs.reduce((acc, ex) => {
    const best = ex.options.find((o) => o.id === ex.bestOptionId);
    return acc + (best ? best.cost : 0);
  }, 0);
}

function buildSwapSuggestions(
  day: DayScenario,
  maxIncorrect: number
): { id: string; text: string; correct: boolean }[] {
  const correctSuggestions = day.executions.map((ex) => ({
    id: `s-${ex.id}-correct`,
    text: `${ex.pair}: execute the best swap for ${ex.valueDate}`,
    correct: true,
  }));

  const decoys = [
    { id: `d-${day.dayIndex}-1`, text: "Trade the same direction twice to ‘average’ the cost", correct: false },
    { id: `d-${day.dayIndex}-2`, text: "Use the widest spread swap because it ‘looks safer’", correct: false },
    { id: `d-${day.dayIndex}-3`, text: "Always trade the longest tenor first, regardless of carry", correct: false },
    { id: `d-${day.dayIndex}-4`, text: "Pick the option with the biggest number (must be best)", correct: false },
    { id: `d-${day.dayIndex}-5`, text: "Ignore value date and just match the pair", correct: false },
  ];

  const incorrectSuggestions = decoys.slice(0, clamp(maxIncorrect, 0, decoys.length));
  const mixed = [...correctSuggestions, ...incorrectSuggestions];
  return mixed.slice(0, Math.min(8, mixed.length));
}

function getDayComparisonMessage(prev?: DayPerformance, curr?: DayPerformance) {
  if (!prev || !curr) return "";
  if (curr.dayIndex === 1) return "";

  const prevRatio = prev.total ? prev.correct / prev.total : 0;
  const currRatio = curr.total ? curr.correct / curr.total : 0;

  if (currRatio > prevRatio + 1e-9) return "You’re improving — keep it going tomorrow.";
  if (currRatio < prevRatio - 1e-9) return "Harder day today — keep going for tomorrow.";

  const prevVar = prev.actualCost - prev.bestPossibleCost;
  const currVar = curr.actualCost - curr.bestPossibleCost;
  if (currVar < prevVar - 1e-9) return "Nice — same score, but you reduced cost vs target.";
  if (currVar > prevVar + 1e-9) return "Same score — but it was a tougher cost day. Keep going tomorrow.";
  return "Same score and cost — steady. Keep going tomorrow.";
}

function PanelCard(props: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="text-sm font-semibold text-slate-900">{props.title}</div>
        {props.right}
      </div>
      <div className="p-4">{props.children}</div>
    </div>
  );
}

function Pill(props: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-800">
      {props.children}
    </span>
  );
}

function Divider() {
  return <div className="my-4 h-px bg-slate-200" />;
}

function Modal(props: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
}) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="text-base font-semibold text-slate-900">{props.title}</div>
          {props.onClose ? (
            <button
              onClick={props.onClose}
              className="rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
            >
              ✕
            </button>
          ) : null}
        </div>
        <div className="px-5 py-4">{props.children}</div>
        {props.actions ? <div className="border-t border-slate-100 px-5 py-4">{props.actions}</div> : null}
      </div>
    </div>
  );
}

function makeDays(): DayScenario[] {
  return [
    {
      dayIndex: 1,
      valueDateLabel: "T+2 (Day 1)",
      rateMatrix: [
        { pair: "EURUSD", bid: 1.0861, ask: 1.0863 },
        { pair: "GBPUSD", bid: 1.2748, ask: 1.2751 },
        { pair: "USDJPY", bid: 147.21, ask: 147.25 },
        { pair: "AUDUSD", bid: 0.6619, ask: 0.6622 },
      ],
      blotterRows: [
        { ccy: "USD", amount: -12_000_000 },
        { ccy: "EUR", amount: 6_000_000 },
        { ccy: "GBP", amount: 4_000_000 },
        { ccy: "JPY", amount: 450_000_000 },
      ],
      notes: [
        "Blotter is informational — solve the executions below with best (or marginal) swap choices.",
        "Try to minimise cost while keeping the value date aligned to the scenario.",
      ],
      executions: [
        {
          id: "d1-e1",
          pair: "EURUSD",
          valueDate: "T+2",
          prompt: "You need to roll EURUSD exposure to match the value date.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 135.2 },
            { id: "o2", label: "Spot + 2W swap", cost: 122.5 },
            { id: "o3", label: "Spot + 1M swap", cost: 121.9 },
            { id: "o4", label: "Do nothing", cost: 220.0 },
          ],
          bestOptionId: "o3",
          marginalOptionIds: ["o2"],
        },
        {
          id: "d1-e2",
          pair: "GBPUSD",
          valueDate: "T+2",
          prompt: "Pick the cleanest GBPUSD roll for value date alignment.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 98.1 },
            { id: "o2", label: "Spot + 2W swap", cost: 92.2 },
            { id: "o3", label: "Spot + 1M swap", cost: 93.0 },
            { id: "o4", label: "Reverse it (wrong direction)", cost: 170.0 },
          ],
          bestOptionId: "o2",
          marginalOptionIds: ["o3"],
        },
        {
          id: "d1-e3",
          pair: "USDJPY",
          valueDate: "T+2",
          prompt: "You have a USDJPY settlement mismatch — choose the best execution.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 110.0 },
            { id: "o2", label: "Spot + 2W swap", cost: 101.4 },
            { id: "o3", label: "Spot + 1M swap", cost: 100.8 },
            { id: "o4", label: "Force spot settlement", cost: 160.0 },
          ],
          bestOptionId: "o3",
          marginalOptionIds: ["o2"],
        },
      ],
    },
    {
      dayIndex: 2,
      valueDateLabel: "T+2 (Day 2)",
      rateMatrix: [
        { pair: "EURUSD", bid: 1.0812, ask: 1.0814 },
        { pair: "GBPUSD", bid: 1.2689, ask: 1.2692 },
        { pair: "USDJPY", bid: 146.42, ask: 146.46 },
        { pair: "USDCAD", bid: 1.3511, ask: 1.3514 },
      ],
      blotterRows: [
        { ccy: "USD", amount: -9_000_000 },
        { ccy: "EUR", amount: 7_500_000 },
        { ccy: "CAD", amount: 3_200_000 },
        { ccy: "JPY", amount: 220_000_000 },
      ],
      notes: [
        "Day 2 typically has tighter choices — focus on cost and value date.",
        "Marginal options can be acceptable in guided mode, but best is always the target.",
      ],
      executions: [
        {
          id: "d2-e1",
          pair: "USDCAD",
          valueDate: "T+2",
          prompt: "Roll USDCAD exposure efficiently.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 88.4 },
            { id: "o2", label: "Spot + 2W swap", cost: 86.2 },
            { id: "o3", label: "Spot + 1M swap", cost: 87.0 },
            { id: "o4", label: "Unwind and re-open later", cost: 140.0 },
          ],
          bestOptionId: "o2",
          marginalOptionIds: ["o3"],
        },
        {
          id: "d2-e2",
          pair: "EURUSD",
          valueDate: "T+2",
          prompt: "Choose the best EURUSD execution for the roll.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 120.3 },
            { id: "o2", label: "Spot + 2W swap", cost: 119.8 },
            { id: "o3", label: "Spot + 1M swap", cost: 118.9 },
            { id: "o4", label: "Wrong-way reversal", cost: 175.0 },
          ],
          bestOptionId: "o3",
          marginalOptionIds: ["o2"],
        },
        {
          id: "d2-e3",
          pair: "GBPUSD",
          valueDate: "T+2",
          prompt: "Align GBPUSD settlement with minimal cost.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 105.6 },
            { id: "o2", label: "Spot + 2W swap", cost: 101.1 },
            { id: "o3", label: "Spot + 1M swap", cost: 101.6 },
            { id: "o4", label: "Do nothing", cost: 165.0 },
          ],
          bestOptionId: "o2",
          marginalOptionIds: ["o3"],
        },
      ],
    },
    {
      dayIndex: 3,
      valueDateLabel: "T+2 (Day 3)",
      rateMatrix: [
        { pair: "AUDUSD", bid: 0.6582, ask: 0.6586 },
        { pair: "NZDUSD", bid: 0.6114, ask: 0.6118 },
        { pair: "USDJPY", bid: 148.02, ask: 148.06 },
        { pair: "EURUSD", bid: 1.0890, ask: 1.0892 },
      ],
      blotterRows: [
        { ccy: "USD", amount: -6_000_000 },
        { ccy: "AUD", amount: 9_200_000 },
        { ccy: "NZD", amount: 4_800_000 },
        { ccy: "JPY", amount: 150_000_000 },
      ],
      notes: [
        "Day 3 mixes G10 with higher spread feel — don’t get baited by the wrong direction.",
        "Try to keep your score improving, but if not, focus on cost vs target.",
      ],
      executions: [
        {
          id: "d3-e1",
          pair: "AUDUSD",
          valueDate: "T+2",
          prompt: "Choose the best AUDUSD roll execution.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 112.2 },
            { id: "o2", label: "Spot + 2W swap", cost: 109.8 },
            { id: "o3", label: "Spot + 1M swap", cost: 110.0 },
            { id: "o4", label: "Reverse it (wrong direction)", cost: 168.0 },
          ],
          bestOptionId: "o2",
          marginalOptionIds: ["o3"],
        },
        {
          id: "d3-e2",
          pair: "NZDUSD",
          valueDate: "T+2",
          prompt: "Pick the cleanest NZDUSD execution.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 96.3 },
            { id: "o2", label: "Spot + 2W swap", cost: 95.9 },
            { id: "o3", label: "Spot + 1M swap", cost: 94.8 },
            { id: "o4", label: "Do nothing", cost: 150.0 },
          ],
          bestOptionId: "o3",
          marginalOptionIds: ["o2"],
        },
        {
          id: "d3-e3",
          pair: "USDJPY",
          valueDate: "T+2",
          prompt: "Minimise cost on USDJPY settlement alignment.",
          options: [
            { id: "o1", label: "Spot + 1W swap", cost: 122.0 },
            { id: "o2", label: "Spot + 2W swap", cost: 118.1 },
            { id: "o3", label: "Spot + 1M swap", cost: 118.9 },
            { id: "o4", label: "Force spot settlement", cost: 160.0 },
          ],
          bestOptionId: "o2",
          marginalOptionIds: ["o3"],
        },
      ],
    },
  ];
}

export default function Page() {
  const days = useMemo(() => makeDays(), []);
  const [mode, setMode] = useState<Mode>("basic");
  const [dayPtr, setDayPtr] = useState(0);

  const day = days[dayPtr];

  const [picks, setPicks] = useState<Record<string, PickResult>>({});
  const [history, setHistory] = useState<DayPerformance[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalBody, setModalBody] = useState<React.ReactNode>(null);

  const [guidedReveal, setGuidedReveal] = useState(false);
  const guidedRevealRef = useRef(false);

  // Keep setter only (avoid eslint “unused var” in Vercel builds)
  const [, setWrongChoicePending] = useState<{
    executionId: string;
    pickedOptionId: string;
  } | null>(null);

  // Prevent “Day Complete” modal opening repeatedly due to state updates
  const completionShownKeyRef = useRef<string>("");

  const bestPossibleCost = useMemo(() => sumBestPossibleCost(day.executions), [day.executions]);

  const totalSoFar = useMemo(() => Object.keys(picks).length, [picks]);

  const { correctSoFar, marginalCorrectSoFar, bestCorrectSoFar, actualCostSoFar } = useMemo(() => {
    let correct = 0;
    let marginal = 0;
    let best = 0;
    let cost = 0;

    for (const ex of day.executions) {
      const r = picks[ex.id];
      if (!r) continue;

      cost += r.cost;

      if (mode === "basic") {
        if (r.isCorrectBasic) correct += 1;
      } else {
        if (r.isCorrectGuided) correct += 1;
      }

      if (r.isBest) best += 1;
      if (r.isMarginal) marginal += 1;
    }

    return { correctSoFar: correct, marginalCorrectSoFar: marginal, bestCorrectSoFar: best, actualCostSoFar: cost };
  }, [day.executions, picks, mode]);

  const isDayComplete = useMemo(() => day.executions.every((ex) => !!picks[ex.id]), [day.executions, picks]);

  const dailyScoreStr = useMemo(() => formatScore(correctSoFar, day.executions.length), [correctSoFar, day.executions.length]);

  const dailyVariance = useMemo(() => actualCostSoFar - bestPossibleCost, [actualCostSoFar, bestPossibleCost]);

  const suggestions = useMemo(() => buildSwapSuggestions(day, 3), [day]);

  const getOptionsForExecution = (ex: Execution) => {
    if (mode !== "guided") return ex.options;
    const seed = day.dayIndex * 100000 + ex.id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) * 97;
    return seededShuffle(ex.options, seed);
  };

  // Reset on day change or mode change
  useEffect(() => {
    setPicks({});
    setGuidedReveal(false);
    guidedRevealRef.current = false;
    setWrongChoicePending(null);
    completionShownKeyRef.current = ""; // allow completion modal for the new state
  }, [dayPtr, mode, setWrongChoicePending]);

  function openInfoModal(title: string, body: React.ReactNode) {
    setModalTitle(title);
    setModalBody(body);
    setModalOpen(true);
  }

  function closeModalAndMaybeAdvanceDay() {
    setModalOpen(false);
    setGuidedReveal(false);
    guidedRevealRef.current = false;

    if (!isDayComplete) return;

    const perf: DayPerformance = {
      dayIndex: day.dayIndex,
      correct: correctSoFar,
      total: day.executions.length,
      marginalCorrect: mode === "guided" ? marginalCorrectSoFar : 0,
      bestCorrect: bestCorrectSoFar,
      actualCost: actualCostSoFar,
      bestPossibleCost,
    };

    setHistory((prev) => {
      const filtered = prev.filter((p) => p.dayIndex !== perf.dayIndex);
      return [...filtered, perf].sort((a, b) => a.dayIndex - b.dayIndex);
    });

    setDayPtr((prev) => (prev + 1 < days.length ? prev + 1 : prev));
  }

  function recordPick(ex: Execution, pickedOption: Option) {
    const isBest = pickedOption.id === ex.bestOptionId;
    const isMarginal = ex.marginalOptionIds.includes(pickedOption.id);
    const isCorrectBasic = isBest; // BASIC: only best counts as correct
    const isCorrectGuided = isBest || isMarginal; // GUIDED: best or marginal counts as correct

    const result: PickResult = {
      executionId: ex.id,
      pickedOptionId: pickedOption.id,
      isBest,
      isMarginal,
      isCorrectBasic,
      isCorrectGuided,
      cost: pickedOption.cost,
    };

    setPicks((prev) => ({ ...prev, [ex.id]: result }));
    return result;
  }

  function onChooseOption(ex: Execution, opt: Option) {
    if (picks[ex.id]) return;

    const result = recordPick(ex, opt);
    const correct = mode === "basic" ? result.isCorrectBasic : result.isCorrectGuided;

    if (!correct) {
      setWrongChoicePending({ executionId: ex.id, pickedOptionId: opt.id });

      openInfoModal(
        "Bad Swap Execution - Trade a Reversal?",
        <div className="space-y-3">
          <div className="text-sm text-slate-700">You executed a bad swap. Would you like to trade a reversal?</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              onClick={() => {
                // YES: redo that execution (simple reversal behaviour)
                setModalOpen(false);
                setWrongChoicePending(null);
                setPicks((prev) => {
                  const copy = { ...prev };
                  delete copy[ex.id];
                  return copy;
                });
              }}
            >
              Yes
            </button>
            <button
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={() => {
                // NO: accept and move on
                setModalOpen(false);
                setWrongChoicePending(null);
              }}
            >
              No
            </button>
          </div>
          <div className="text-xs text-slate-500">
            Tip: in guided mode you can still score “correct” with marginal choices — but wrong-direction / wrong-tenor is costly.
          </div>
        </div>
      );
      return;
    }

    if (mode === "guided") {
      setGuidedReveal(false);
      guidedRevealRef.current = false;

      openInfoModal(
        "Execution Recorded",
        <div className="space-y-3">
          <div className="text-sm text-slate-700">Execution captured. Click below to reveal whether it was best or marginal.</div>
          <button
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            onClick={() => {
              setGuidedReveal(true);
              guidedRevealRef.current = true;
            }}
          >
            Reveal
          </button>

          {guidedReveal ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
              {result.isBest ? (
                <div>
                  <div className="font-semibold">Best execution ✅</div>
                  <div className="text-slate-600">Cost: {formatMoney(result.cost)}</div>
                </div>
              ) : (
                <div>
                  <div className="font-semibold">Marginal execution ✅</div>
                  <div className="text-slate-600">Cost: {formatMoney(result.cost)}</div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      );
      return;
    }

    openInfoModal(
      "Execution Recorded",
      <div className="space-y-2 text-sm text-slate-700">
        <div>
          Result: <span className="font-semibold text-slate-900">Best execution ✅</span>
        </div>
        <div>Cost: {formatMoney(result.cost)}</div>
      </div>
    );
  }

  // Open completion modal once per (dayIndex + mode) when the day is complete
  useEffect(() => {
    if (!isDayComplete) return;

    const key = `${day.dayIndex}-${mode}`;
    if (completionShownKeyRef.current === key) return;
    completionShownKeyRef.current = key;

    const prev = history.find((h) => h.dayIndex === day.dayIndex - 1);
    const curr: DayPerformance = {
      dayIndex: day.dayIndex,
      correct: correctSoFar,
      total: day.executions.length,
      marginalCorrect: mode === "guided" ? marginalCorrectSoFar : 0,
      bestCorrect: bestCorrectSoFar,
      actualCost: actualCostSoFar,
      bestPossibleCost,
    };

    const msg = day.dayIndex > 1 ? getDayComparisonMessage(prev, curr) : "";
    const guidedMarginalPct = mode === "guided" && curr.correct > 0 ? curr.marginalCorrect / curr.correct : 0;

    openInfoModal(
      `Day ${day.dayIndex} Complete`,
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Pill>Score: {formatScore(curr.correct, curr.total)}</Pill>
          <Pill>Actual cost: {formatMoney(curr.actualCost)}</Pill>
          <Pill>Target (best): {formatMoney(curr.bestPossibleCost)}</Pill>
          <Pill>Variance: {formatMoney(curr.actualCost - curr.bestPossibleCost)}</Pill>
          {mode === "guided" ? <Pill>Marginal share: {formatPct(guidedMarginalPct)}</Pill> : null}
        </div>

        {msg ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">{msg}</div>
        ) : null}

        <div className="text-sm text-slate-700">Close this box to roll forward to the next value date/day.</div>
      </div>
    );
  }, [
    isDayComplete,
    day.dayIndex,
    mode,
    history,
    correctSoFar,
    marginalCorrectSoFar,
    bestCorrectSoFar,
    actualCostSoFar,
    bestPossibleCost,
    day.executions.length,
  ]);

  const scoreHistoryRow = useMemo(() => {
    if (history.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-2">
        {history.map((h) => (
          <Pill key={`score-${h.dayIndex}`}>
            Day {h.dayIndex}: {formatScore(h.correct, h.total)}
          </Pill>
        ))}
      </div>
    );
  }, [history]);

  const costHistoryRow = useMemo(() => {
    if (history.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-2">
        {history.map((h) => (
          <Pill key={`cost-${h.dayIndex}`}>
            Day {h.dayIndex}: {formatMoney(h.actualCost)} (target {formatMoney(h.bestPossibleCost)})
          </Pill>
        ))}
      </div>
    );
  }, [history]);

  const pageTitle = mode === "basic" ? "Basic" : "Guided";

  return (
    <div className="min-h-screen bg-slate-50">
      <Modal
        open={modalOpen}
        title={modalTitle}
        onClose={closeModalAndMaybeAdvanceDay}
        actions={
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={closeModalAndMaybeAdvanceDay}
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Close
            </button>
          </div>
        }
      >
        {modalBody}
      </Modal>

      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-2xl font-bold text-slate-900">FX Swaps Training</div>
            <div className="text-sm text-slate-600">
              {pageTitle} game · Value date: <span className="font-semibold">{day.valueDateLabel}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setMode("basic")}
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                mode === "basic"
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
              }`}
            >
              Basic
            </button>
            <button
              onClick={() => setMode("guided")}
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                mode === "guided"
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
              }`}
            >
              Guided
            </button>

            <div className="ml-2 flex items-center gap-2">
              <Pill>Score: {dailyScoreStr}</Pill>
              <Pill>
                Cost: {formatMoney(actualCostSoFar)} / Target {formatMoney(bestPossibleCost)}
              </Pill>
              <Pill>Var: {formatMoney(dailyVariance)}</Pill>
            </div>
          </div>
        </div>

        <Divider />

        <div className="space-y-2">{scoreHistoryRow ? <PanelCard title="Final Scores by Day">{scoreHistoryRow}</PanelCard> : null}</div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <PanelCard
              title="Rate Matrix"
              right={
                <div className="flex items-center gap-2">
                  <Pill>
                    Day {day.dayIndex} of {days.length}
                  </Pill>
                  <Pill>{mode === "basic" ? "Best-only scoring" : "Best + Marginal scoring"}</Pill>
                </div>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Pair</th>
                      <th className="py-2 pr-3">Bid</th>
                      <th className="py-2 pr-3">Ask</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.rateMatrix.map((r) => (
                      <tr key={r.pair} className="border-t border-slate-100">
                        <td className="py-2 pr-3 font-semibold text-slate-900">{r.pair}</td>
                        <td className="py-2 pr-3 text-slate-700">{r.bid}</td>
                        <td className="py-2 pr-3 text-slate-700">{r.ask}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {costHistoryRow ? (
                <div className="mt-4">
                  <div className="text-xs font-semibold uppercase text-slate-500">Cost Tracker</div>
                  <div className="mt-2">{costHistoryRow}</div>
                </div>
              ) : null}
            </PanelCard>

            <PanelCard title="Executions">
              <div className="space-y-4">
                {day.executions.map((ex, idx) => {
                  const done = picks[ex.id];
                  const options = getOptionsForExecution(ex);

                  return (
                    <div key={ex.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">
                            {idx + 1}. {ex.pair} · {ex.valueDate}
                          </div>
                          <div className="text-sm text-slate-600">{ex.prompt}</div>
                        </div>

                        <div className="flex items-center gap-2">
                          {done ? (
                            <>
                              <Pill>Picked</Pill>
                              <Pill>Cost {formatMoney(done.cost)}</Pill>
                              <Pill>{(mode === "basic" ? done.isCorrectBasic : done.isCorrectGuided) ? "Correct ✅" : "Wrong ❌"}</Pill>
                            </>
                          ) : (
                            <Pill>Not done</Pill>
                          )}
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                        {options.map((opt) => (
                          <button
                            key={opt.id}
                            disabled={!!done}
                            onClick={() => onChooseOption(ex, opt)}
                            className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                              done ? "border-slate-200 bg-slate-50 text-slate-500" : "border-slate-300 bg-white hover:bg-slate-50"
                            }`}
                          >
                            <div className="font-semibold text-slate-900">{opt.label}</div>
                            <div className="text-slate-600">Cost: {formatMoney(opt.cost)}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </PanelCard>
          </div>

          <div className="space-y-4">
            <PanelCard title="Blotter">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">CCY</th>
                      <th className="py-2 pr-3">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.blotterRows.map((r, i) => (
                      <tr key={`${r.ccy}-${i}`} className="border-t border-slate-100">
                        <td className="py-2 pr-3 font-semibold text-slate-900">{r.ccy}</td>
                        <td className="py-2 pr-3 text-slate-700">{r.amount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PanelCard>

            <PanelCard title="Swap Suggestion">
              <div className="space-y-2">
                <div className="text-sm text-slate-700">
                  Quick “what to trade” prompts (kept short so the game finishes quickly).
                </div>

                <div className="space-y-2">
                  {suggestions.map((s) => (
                    <div
                      key={s.id}
                      className={`rounded-xl border p-3 text-sm ${
                        s.correct ? "border-slate-200 bg-white" : "border-amber-200 bg-amber-50"
                      }`}
                    >
                      <div className="font-semibold text-slate-900">{s.text}</div>
                      <div className="text-xs text-slate-600">{s.correct ? "Relevant" : "Decoy (max 3 per day)"}</div>
                    </div>
                  ))}
                </div>
              </div>
            </PanelCard>

            <PanelCard title="Progress">
              <div className="space-y-2 text-sm text-slate-700">
                <div>
                  Executions completed:{" "}
                  <span className="font-semibold text-slate-900">
                    {totalSoFar}/{day.executions.length}
                  </span>
                </div>
                <div>
                  Score: <span className="font-semibold text-slate-900">{formatScore(correctSoFar, day.executions.length)}</span>
                </div>
                <div>
                  Cost vs target:{" "}
                  <span className="font-semibold text-slate-900">
                    {formatMoney(actualCostSoFar)} / {formatMoney(bestPossibleCost)}
                  </span>
                </div>
                <div>
                  Variance: <span className="font-semibold text-slate-900">{formatMoney(dailyVariance)}</span>
                </div>

                {mode === "guided" ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    Guided scoring: <span className="font-semibold">Best</span> and <span className="font-semibold">Marginal</span> count as correct. Day completion shows the marginal share.
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    Basic scoring: only the <span className="font-semibold">Best</span> execution counts as correct.
                  </div>
                )}
              </div>
            </PanelCard>
          </div>
        </div>

        <div className="mt-4">
          <PanelCard title="Notes (for this day)">
            <ul className="list-disc space-y-2 pl-5 text-sm text-slate-700">
              {day.notes.map((n, i) => (
                <li key={`note-${i}`}>{n}</li>
              ))}
            </ul>
          </PanelCard>
        </div>

        <div className="mt-6 text-center text-xs text-slate-500">
          {dayPtr >= days.length - 1 && isDayComplete ? "You’ve completed the last available day in this demo set." : null}
        </div>
      </div>
    </div>
  );
}
