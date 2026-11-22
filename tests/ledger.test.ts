import { describe, expect, it } from "vitest";

import type { BeginInput, LedgerState } from "../src/quota/ledger";
import { begin, emptyState, release, reservedNanoEur, settle, status } from "../src/quota/ledger";

const NOW = Date.UTC(2026, 10, 20, 12);
const MINUTE = 60_000;
const LIMITS = { perHour: 2, perDay: 3, poolNanoEur: 1000 };

const input = (overrides: Partial<BeginInput> = {}): BeginInput => ({
  now: NOW,
  ip: "1.1.1.1",
  skipNetworkLimit: false,
  reserveNanoEur: 100,
  reservationId: crypto.randomUUID(),
  limits: LIMITS,
  ...overrides,
});

const beginAll = (inputs: BeginInput[]): LedgerState =>
  inputs.reduce((state, next) => begin(state, next).state, emptyState(NOW));

describe("ledger", () => {
  it("holds a reservation until it is settled at the real cost", () => {
    const begun = begin(emptyState(NOW), input({ reservationId: "a" }));
    expect(begun.result).toEqual({ ok: true });
    expect(reservedNanoEur(begun.state)).toBe(100);
    const settled = settle(begun.state, { now: NOW, reservationId: "a", actualNanoEur: 7 }).state;
    expect(settled.spentNanoEur).toBe(7);
    expect(reservedNanoEur(settled)).toBe(0);
  });

  it("gives a released reservation back in full", () => {
    const begun = begin(emptyState(NOW), input({ reservationId: "a" })).state;
    const released = release(begun, { now: NOW, reservationId: "a" }).state;
    expect(released.spentNanoEur).toBe(0);
    expect(reservedNanoEur(released)).toBe(0);
  });

  it("counts reservations against the pool so concurrent runs cannot overshoot", () => {
    const state = beginAll([
      input({ ip: "a", reserveNanoEur: 600 }),
      input({ ip: "b", reserveNanoEur: 300 }),
    ]);
    const refused = begin(state, input({ ip: "c", reserveNanoEur: 200 }));
    expect(refused.result).toMatchObject({ ok: false, error: "budget" });
    expect(reservedNanoEur(refused.state)).toBe(900);
  });

  it("tells a paused pool to retry at the next UTC month", () => {
    const refused = begin(emptyState(NOW), input({ reserveNanoEur: 5000 })).result;
    const untilDecember = (Date.UTC(2026, 11, 1) - NOW) / 1000;
    expect(refused).toEqual({ ok: false, error: "budget", retryAfterSeconds: untilDecember });
  });

  it("limits one network per hour, then per day, with the wait until a slot frees", () => {
    const state = beginAll([input(), input({ now: NOW + MINUTE })]);
    const hourly = begin(state, input({ now: NOW + 2 * MINUTE })).result;
    expect(hourly).toEqual({ ok: false, error: "ip_hour", retryAfterSeconds: 58 * 60 });
    const later = begin(state, input({ now: NOW + 61 * MINUTE })).state;
    const daily = begin(later, input({ now: NOW + 125 * MINUTE })).result;
    expect(daily).toMatchObject({ ok: false, error: "ip_day" });
  });

  it("does not spend a network slot on a request the pool refused", () => {
    const refused = begin(emptyState(NOW), input({ reserveNanoEur: 5000 })).state;
    expect(refused.ips["1.1.1.1"]).toBeUndefined();
  });

  it("counts a reservation nobody settled within two minutes as spent at its reserve", () => {
    const begun = begin(emptyState(NOW), input({ reserveNanoEur: 900 })).state;
    const view = status(begun, { now: NOW + 3 * MINUTE, limits: LIMITS }).result;
    expect(view).toMatchObject({ reservedNanoEur: 0, spentNanoEur: 900 });
    const refused = begin(begun, input({ now: NOW + 3 * MINUTE, reserveNanoEur: 200 })).result;
    expect(refused).toMatchObject({ ok: false, error: "budget" });
  });

  it("corrects a lapsed reservation to the real cost when its run settles late", () => {
    const begun = begin(emptyState(NOW), input({ reservationId: "slow", reserveNanoEur: 900 }));
    const late = { now: NOW + 3 * MINUTE, reservationId: "slow" };
    expect(settle(begun.state, { ...late, actualNanoEur: 40 }).state.spentNanoEur).toBe(40);
    expect(release(begun.state, late).state.spentNanoEur).toBe(0);
  });

  it("charges a run once however often its settlement arrives", () => {
    const begun = begin(emptyState(NOW), input({ reservationId: "a" })).state;
    const settlement = { now: NOW, reservationId: "a", actualNanoEur: 7 };
    const twice = settle(settle(begun, settlement).state, settlement).state;
    expect(twice.spentNanoEur).toBe(7);
    expect(settle(emptyState(NOW), settlement).state.spentNanoEur).toBe(0);
  });

  it("refuses a second reservation under an id that is still open", () => {
    const begun = begin(emptyState(NOW), input({ reservationId: "a" })).state;
    const again = begin(begun, input({ reservationId: "a", ip: "2.2.2.2" })).result;
    expect(again).toMatchObject({ ok: false, error: "bad_reserve" });
  });

  it("carries a run that is still open into the next month's pool", () => {
    const lastMinute = Date.UTC(2026, 10, 30, 23, 59, 30);
    const begun = begin(emptyState(lastMinute), input({ now: lastMinute, reservationId: "a" }));
    const december = Date.UTC(2026, 11, 1, 0, 0, 10);
    const view = status(begun.state, { now: december, limits: LIMITS }).result;
    expect(view).toMatchObject({ month: "2026-12", spentNanoEur: 0, reservedNanoEur: 100 });
    const settled = settle(begun.state, { now: december, reservationId: "a", actualNanoEur: 7 });
    expect(settled.state.spentNanoEur).toBe(7);
  });

  it("starts the pool again on the first of the month and keeps the network counts", () => {
    const begun = begin(emptyState(NOW), input({ reservationId: "a" })).state;
    const spent = settle(begun, { now: NOW, reservationId: "a", actualNanoEur: 1000 }).state;
    const december = Date.UTC(2026, 11, 1, 0, 0, 1);
    const view = status(spent, { now: december, limits: LIMITS });
    expect(view.result).toMatchObject({ month: "2026-12", spentNanoEur: 0, accepting: true });
    expect(status(spent, { now: NOW, limits: LIMITS }).result.accepting).toBe(false);
  });

  it("leaves the network limit out for an authenticated subject", () => {
    const authenticated = { skipNetworkLimit: true };
    const state = beginAll([input(authenticated), input(authenticated), input(authenticated)]);
    expect(state.reservations).toHaveLength(3);
    expect(state.ips).toEqual({});
  });

  it.each([0, -5, 1.5, Number.NaN])("refuses to reserve %s", (reserveNanoEur) => {
    const refused = begin(emptyState(NOW), input({ reserveNanoEur })).result;
    expect(refused).toMatchObject({ ok: false, error: "bad_reserve" });
  });
});
