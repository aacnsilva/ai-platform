---
name: verify-quota
description: Verify limits and money - per-network limits, the monthly pool per tenant, reserve before the run and settle after. Use after changing src/quota, src/llm/cost.ts, src/llm/catalog.ts or the reserve and settle calls in src/agent/run.ts.
---

# Verify quota

## Run

```bash
npx vitest run tests/ledger.test.ts tests/cost.test.ts tests/run.test.ts
npx vitest run tests/invariants/ledger.test.ts tests/interleavings/pool.test.ts
npx vitest run --config e2e/vitest.config.ts quota
```

## What it proves

- An answered run is settled at the real token cost, to the nano-euro.
- A network over its hourly limit gets 429 with `Retry-After`, and the provider is never called.
- A pool that cannot cover the next reservation refuses with `budget` until the next UTC month.
- Reservations count against the pool, so concurrent runs cannot overshoot it.
- A reservation nobody settled within two minutes is counted as spent at its reserve, corrected to
  the real cost if the run settles within the hour after, and never freed for another run.
- A settlement that arrives twice, or for a reservation that is unknown, charges nothing more.
- A run still held at the end of the month is held against the next month's pool; one that lapsed
  is charged to the month it was made in.
- The reserve prices the prompt at the cache-write rate, the dearest a prompt token can be.
- A failure before the model wrote anything gives the reservation back; a timeout or a stream
  that broke after it began is counted at the reserved worst case.
- One tenant's limits never touch another tenant.

## When prices or models change

Prices live in `src/llm/catalog.ts` in nano-dollars per token. Change a price and its test in
`tests/cost.test.ts` together, from the provider's published pricing page, and say which day you
read it in the commit message. A model without a verified price must not be added.
