import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import type {
  BeginInput,
  BeginResult,
  LedgerState,
  NetworkInput,
  PoolStatus,
  ReleaseInput,
  SettleInput,
  StatusInput,
  Step,
} from "./ledger";
import { begin, DAY_MS, emptyState, noteNetwork, release, settle, status } from "./ledger";

const STATE_KEY = "state";
const PRUNE_EVERY = 500;
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ip_hits (ip TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ip_hits_ip_at ON ip_hits (ip, at)",
  "CREATE INDEX IF NOT EXISTS ip_hits_at ON ip_hits (at)",
];

type Row = Record<string, SqlStorageValue>;

const stripped = (state: LedgerState): LedgerState => ({ ...state, ips: {} });

export class Ledger extends DurableObject<Env> {
  private state: LedgerState | undefined;
  private writes = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const statement of SCHEMA) {
      ctx.storage.sql.exec(statement);
    }
  }

  async begin(input: BeginInput): Promise<BeginResult> {
    const base = await this.load(input.now);
    const ips = input.skipNetworkLimit ? {} : { [input.ip]: this.hitsFor(input.ip, input.now) };
    const step = begin({ ...base, ips }, input);
    await this.save(stripped(step.state));
    if (step.result.ok && !input.skipNetworkLimit) {
      this.recordHit(input.ip, input.now);
    }
    return step.result;
  }

  noteNetwork(input: NetworkInput): BeginResult {
    const transient = {
      ...emptyState(input.now),
      ips: { [input.ip]: this.hitsFor(input.ip, input.now) },
    };
    const step = noteNetwork(transient, input);
    if (step.result.ok) {
      this.recordHit(input.ip, input.now);
    }
    return step.result;
  }

  async settle(input: SettleInput): Promise<void> {
    await this.apply(input.now, (state) => settle(state, input));
  }

  async release(input: ReleaseInput): Promise<void> {
    await this.apply(input.now, (state) => release(state, input));
  }

  async status(input: StatusInput): Promise<PoolStatus> {
    const base = await this.load(input.now);
    return status(base, input).result;
  }

  private async load(now: number): Promise<LedgerState> {
    if (this.state !== undefined) {
      return this.state;
    }
    const stored = (await this.ctx.storage.get<LedgerState>(STATE_KEY)) ?? emptyState(now);
    const legacy = Object.entries(stored.ips);
    if (legacy.length > 0) {
      this.migrateHits(legacy, now);
      const clean = stripped(stored);
      this.state = clean;
      await this.ctx.storage.put(STATE_KEY, clean);
      return clean;
    }
    this.state = stored;
    return stored;
  }

  private migrateHits(entries: readonly [string, number[]][], now: number): void {
    const cutoff = now - DAY_MS;
    const { sql } = this.ctx.storage;
    this.ctx.storage.transactionSync(() => {
      for (const [ip, hits] of entries) {
        for (const hit of hits) {
          if (hit >= cutoff) {
            sql.exec("INSERT INTO ip_hits (ip, at) VALUES (?, ?)", ip, hit);
          }
        }
      }
    });
  }

  private hitsFor(ip: string, now: number): number[] {
    return this.ctx.storage.sql
      .exec<Row>("SELECT at FROM ip_hits WHERE ip = ? AND at >= ?", ip, now - DAY_MS)
      .toArray()
      .flatMap((row) => (typeof row["at"] === "number" ? [row["at"]] : []));
  }

  private recordHit(ip: string, now: number): void {
    this.ctx.storage.sql.exec("INSERT INTO ip_hits (ip, at) VALUES (?, ?)", ip, now);
    this.writes += 1;
    if (this.writes % PRUNE_EVERY === 0) {
      this.ctx.storage.sql.exec("DELETE FROM ip_hits WHERE at < ?", now - DAY_MS);
    }
  }

  private async save(next: LedgerState): Promise<void> {
    this.state = next;
    await this.ctx.storage.put(STATE_KEY, next);
  }

  private async apply<T>(now: number, transition: (state: LedgerState) => Step<T>): Promise<T> {
    const step = transition(await this.load(now));
    await this.save(stripped(step.state));
    return step.result;
  }
}
