const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const RESERVATION_TTL_MS = 2 * 60 * 1000;
export const LAPSED_TTL_MS = HOUR_MS;
const MAX_TRACKED_IPS = 2000;
const MAX_LAPSED = 2000;

export interface Reservation {
  id: string;
  nanoEur: number;
  at: number;
}

export interface LedgerState {
  month: string;
  spentNanoEur: number;
  reservations: Reservation[];
  lapsed?: Reservation[];
  ips: Record<string, number[]>;
}

export interface Limits {
  perHour: number;
  perDay: number;
  poolNanoEur: number;
}

export type RefusalCode = "ip_hour" | "ip_day" | "budget" | "bad_reserve";

export interface Refusal {
  ok: false;
  error: RefusalCode;
  retryAfterSeconds: number;
}

export type BeginResult = { ok: true } | Refusal;

export interface Step<T> {
  state: LedgerState;
  result: T;
}

export interface BeginInput {
  now: number;
  ip: string;
  skipNetworkLimit: boolean;
  reserveNanoEur: number;
  reservationId: string;
  limits: Limits;
}

export interface SettleInput {
  now: number;
  reservationId: string;
  actualNanoEur: number;
}

export interface ReleaseInput {
  now: number;
  reservationId: string;
}

export interface StatusInput {
  now: number;
  limits: Limits;
}

export interface PoolStatus {
  accepting: boolean;
  month: string;
  spentNanoEur: number;
  reservedNanoEur: number;
  poolNanoEur: number;
}

export const monthKey = (now: number): string => new Date(now).toISOString().slice(0, 7);

export const secondsUntilNextUtcMonth = (now: number): number => {
  const date = new Date(now);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
};

export const emptyState = (now: number): LedgerState => ({
  month: monthKey(now),
  spentNanoEur: 0,
  reservations: [],
  lapsed: [],
  ips: {},
});

export const lapsedOf = (state: LedgerState): Reservation[] => state.lapsed ?? [];

const total = (reservations: readonly Reservation[]): number =>
  reservations.reduce((sum, reservation) => sum + reservation.nanoEur, 0);

const rollover = (state: LedgerState, now: number): LedgerState =>
  monthKey(now) > state.month
    ? { ...emptyState(now), reservations: state.reservations, ips: state.ips }
    : state;

const newestHit = (hits: readonly number[]): number => Math.max(...hits);

const freshIps = (ips: LedgerState["ips"], now: number): LedgerState["ips"] => {
  const kept = Object.entries(ips)
    .map(([ip, hits]): [string, number[]] => [ip, hits.filter((hit) => hit >= now - DAY_MS)])
    .filter(([, hits]) => hits.length > 0)
    .sort((left, right) => newestHit(left[1]) - newestHit(right[1]));
  return Object.fromEntries(kept.slice(-MAX_TRACKED_IPS));
};

const isLive = (reservation: Reservation, now: number): boolean =>
  now - reservation.at <= RESERVATION_TTL_MS;

const isRemembered = (reservation: Reservation, now: number): boolean =>
  now - reservation.at <= RESERVATION_TTL_MS + LAPSED_TTL_MS;

const lapse = (state: LedgerState, now: number): LedgerState => {
  const expired = state.reservations.filter((reservation) => !isLive(reservation, now));
  const lapsed = [...lapsedOf(state), ...expired]
    .filter((reservation) => isRemembered(reservation, now))
    .slice(-MAX_LAPSED);
  return {
    ...state,
    spentNanoEur: state.spentNanoEur + total(expired),
    reservations: state.reservations.filter((reservation) => isLive(reservation, now)),
    lapsed,
  };
};

const sweep = (state: LedgerState, now: number): LedgerState => {
  const current = rollover(lapse(state, now), now);
  return { ...current, ips: freshIps(current.ips, now) };
};

export const reservedNanoEur = (state: LedgerState): number => total(state.reservations);

const refuse = (error: RefusalCode, retryAfterSeconds: number): Refusal => ({
  ok: false,
  error,
  retryAfterSeconds: Math.max(1, retryAfterSeconds),
});

interface Window {
  spanMs: number;
  limit: number;
  error: RefusalCode;
}

const windowRefusal = (hits: readonly number[], now: number, window: Window): Refusal | null => {
  const inWindow = hits.filter((hit) => hit >= now - window.spanMs);
  if (inWindow.length < window.limit) {
    return null;
  }
  const oldest = Math.min(...inWindow);
  return refuse(window.error, Math.ceil((oldest + window.spanMs - now) / 1000));
};

const networkRefusal = (hits: readonly number[], input: BeginInput): Refusal | null =>
  windowRefusal(hits, input.now, {
    spanMs: HOUR_MS,
    limit: input.limits.perHour,
    error: "ip_hour",
  }) ??
  windowRefusal(hits, input.now, { spanMs: DAY_MS, limit: input.limits.perDay, error: "ip_day" });

const poolRefusal = (state: LedgerState, input: BeginInput): Refusal | null => {
  const held = state.spentNanoEur + reservedNanoEur(state);
  return held + input.reserveNanoEur > input.limits.poolNanoEur
    ? refuse("budget", secondsUntilNextUtcMonth(input.now))
    : null;
};

const isKnown = (state: LedgerState, reservationId: string): boolean =>
  [...state.reservations, ...lapsedOf(state)].some(
    (reservation) => reservation.id === reservationId,
  );

const isPositiveAmount = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export interface NetworkInput {
  now: number;
  ip: string;
  perHour: number;
  perDay: number;
}

export const noteNetwork = (previous: LedgerState, input: NetworkInput): Step<BeginResult> => {
  const state = sweep(previous, input.now);
  const hits = state.ips[input.ip] ?? [];
  const refusal =
    windowRefusal(hits, input.now, { spanMs: HOUR_MS, limit: input.perHour, error: "ip_hour" }) ??
    windowRefusal(hits, input.now, { spanMs: DAY_MS, limit: input.perDay, error: "ip_day" });
  if (refusal !== null) {
    return { state, result: refusal };
  }
  return {
    state: { ...state, ips: { ...state.ips, [input.ip]: [...hits, input.now] } },
    result: { ok: true },
  };
};

export const begin = (previous: LedgerState, input: BeginInput): Step<BeginResult> => {
  const state = sweep(previous, input.now);
  if (!isPositiveAmount(input.reserveNanoEur) || isKnown(state, input.reservationId)) {
    return { state, result: refuse("bad_reserve", 60) };
  }
  const hits = state.ips[input.ip] ?? [];
  const refusal =
    (input.skipNetworkLimit ? null : networkRefusal(hits, input)) ?? poolRefusal(state, input);
  if (refusal !== null) {
    return { state, result: refusal };
  }
  const reservation = { id: input.reservationId, nanoEur: input.reserveNanoEur, at: input.now };
  return {
    state: {
      ...state,
      reservations: [...state.reservations, reservation],
      ips: input.skipNetworkLimit ? state.ips : { ...state.ips, [input.ip]: [...hits, input.now] },
    },
    result: { ok: true },
  };
};

interface Closing {
  state: LedgerState;
  held: Reservation | undefined;
  charged: Reservation | undefined;
}

const close = (previous: LedgerState, reservationId: string, now: number): Closing => {
  const state = sweep(previous, now);
  const isOther = (reservation: Reservation): boolean => reservation.id !== reservationId;
  const isIt = (reservation: Reservation): boolean => reservation.id === reservationId;
  return {
    state: {
      ...state,
      reservations: state.reservations.filter(isOther),
      lapsed: lapsedOf(state).filter(isOther),
    },
    held: state.reservations.find(isIt),
    charged: lapsedOf(state).find(isIt),
  };
};

const spending = (state: LedgerState, change: number): LedgerState => ({
  ...state,
  spentNanoEur: state.spentNanoEur + change,
});

export const settle = (previous: LedgerState, input: SettleInput): Step<null> => {
  const { state, held, charged } = close(previous, input.reservationId, input.now);
  const actual =
    Number.isSafeInteger(input.actualNanoEur) && input.actualNanoEur >= 0 ? input.actualNanoEur : 0;
  if (held !== undefined) {
    return { state: spending(state, actual), result: null };
  }
  return {
    state: charged === undefined ? state : spending(state, actual - charged.nanoEur),
    result: null,
  };
};

export const release = (previous: LedgerState, input: ReleaseInput): Step<null> => {
  const { state, charged } = close(previous, input.reservationId, input.now);
  return { state: charged === undefined ? state : spending(state, -charged.nanoEur), result: null };
};

export const status = (previous: LedgerState, input: StatusInput): Step<PoolStatus> => {
  const state = sweep(previous, input.now);
  const reserved = reservedNanoEur(state);
  return {
    state,
    result: {
      accepting: state.spentNanoEur + reserved < input.limits.poolNanoEur,
      month: state.month,
      spentNanoEur: state.spentNanoEur,
      reservedNanoEur: reserved,
      poolNanoEur: input.limits.poolNanoEur,
    },
  };
};
