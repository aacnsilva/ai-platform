import type { RunEvent } from "./events";

export type OutcomeClass = "answered" | "guarded" | "limited" | "rejected" | "failed";

export const OUTCOME_CLASSES: readonly OutcomeClass[] = [
  "answered",
  "guarded",
  "limited",
  "rejected",
  "failed",
];

export interface Bucket {
  start: number;
  counts: Record<OutcomeClass, number>;
  costNanoEur: number;
  latencyP50: number | null;
  latencyP95: number | null;
  ttftP50: number | null;
}

export interface Totals {
  requests: number;
  counts: Record<OutcomeClass, number>;
  costNanoEur: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRatio: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  ttftP50: number | null;
  ttftP95: number | null;
}

export interface Summary {
  since: number;
  until: number;
  bucketMs: number;
  totals: Totals;
  buckets: Bucket[];
  outcomes: { outcome: string; count: number }[];
  recent: RunEvent[];
}

export interface Window {
  since: number;
  until: number;
  bucketMs: number;
}

const RECENT_LIMIT = 50;
const ANSWERED_OUTCOMES = new Set(["answered", "tool_round"]);

export const classify = (event: RunEvent): OutcomeClass => {
  if (event.status === 429) {
    return "limited";
  }
  if (event.status >= 500) {
    return "failed";
  }
  if (event.status >= 400) {
    return "rejected";
  }
  return ANSWERED_OUTCOMES.has(event.outcome) ? "answered" : "guarded";
};

export const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
};

const emptyCounts = (): Record<OutcomeClass, number> => ({
  answered: 0,
  guarded: 0,
  limited: 0,
  rejected: 0,
  failed: 0,
});

const countByClass = (events: readonly RunEvent[]): Record<OutcomeClass, number> => {
  const counts = emptyCounts();
  for (const event of events) {
    counts[classify(event)] += 1;
  }
  return counts;
};

const sum = (events: readonly RunEvent[], pick: (event: RunEvent) => number): number =>
  events.reduce((total, event) => total + pick(event), 0);

const completedLatencies = (events: readonly RunEvent[]): number[] =>
  events.filter((event) => event.model !== null).map((event) => event.latencyMs);

const firstTokenTimes = (events: readonly RunEvent[]): number[] =>
  events.flatMap((event) => (event.ttftMs === null ? [] : [event.ttftMs]));

const bucketOf = (start: number, events: readonly RunEvent[]): Bucket => ({
  start,
  counts: countByClass(events),
  costNanoEur: sum(events, (event) => event.costNanoEur),
  latencyP50: percentile(completedLatencies(events), 0.5),
  latencyP95: percentile(completedLatencies(events), 0.95),
  ttftP50: percentile(firstTokenTimes(events), 0.5),
});

const bucketsOf = (events: readonly RunEvent[], window: Window): Bucket[] => {
  const grouped = new Map<number, RunEvent[]>();
  for (const event of events) {
    const start = Math.floor(event.at / window.bucketMs) * window.bucketMs;
    const bucket = grouped.get(start);
    if (bucket === undefined) {
      grouped.set(start, [event]);
    } else {
      bucket.push(event);
    }
  }
  const buckets: Bucket[] = [];
  const first = Math.floor(window.since / window.bucketMs) * window.bucketMs;
  for (let start = first; start <= window.until; start += window.bucketMs) {
    buckets.push(bucketOf(start, grouped.get(start) ?? []));
  }
  return buckets;
};

const totalsOf = (events: readonly RunEvent[]): Totals => {
  const cacheRead = sum(events, (event) => event.cacheReadTokens);
  const cacheWrite = sum(events, (event) => event.cacheWriteTokens);
  const input = sum(events, (event) => event.inputTokens);
  const prompt = input + cacheRead + cacheWrite;
  return {
    requests: events.length,
    counts: countByClass(events),
    costNanoEur: sum(events, (event) => event.costNanoEur),
    inputTokens: input,
    outputTokens: sum(events, (event) => event.outputTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheHitRatio: prompt === 0 ? null : cacheRead / prompt,
    latencyP50: percentile(completedLatencies(events), 0.5),
    latencyP95: percentile(completedLatencies(events), 0.95),
    ttftP50: percentile(firstTokenTimes(events), 0.5),
    ttftP95: percentile(firstTokenTimes(events), 0.95),
  };
};

const outcomesOf = (events: readonly RunEvent[]): Summary["outcomes"] => {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.outcome, (counts.get(event.outcome) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((left, right) => right.count - left.count);
};

export const summarize = (events: readonly RunEvent[], window: Window): Summary => ({
  ...window,
  totals: totalsOf(events),
  buckets: bucketsOf(events, window),
  outcomes: outcomesOf(events),
  recent: events.slice(-RECENT_LIMIT).reverse(),
});
