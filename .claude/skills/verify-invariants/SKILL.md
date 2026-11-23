---
name: verify-invariants
description: Verify the correctness guarantees - invariants of the pure state machines, parsers under hostile input, and every ordering of requests, crashes and retries. Use after changing src/quota, src/sessions/turn.ts, src/llm/breaker.ts, src/llm/cost.ts, src/authn, any parser of request or provider data, src/tools/http-tool.ts, or when adding a new state machine or parser.
---

# Verify invariants

Example tests show that the cases someone thought of work. These three suites check rules that must
hold for every input and every ordering, by generating the inputs and orderings.

## Run

```bash
npx vitest run tests/invariants tests/fuzz tests/interleavings
```

All of it also runs in `npm run test` and so in `npm run check`.

A failure prints a `Counterexample` already shrunk to the smallest input that breaks the rule, and a
`seed` and `path`. To replay exactly that case while fixing it, pass them to the failing
`fc.assert` call as `{ seed, path, endOnFailure: true }`, and remove them again before committing.
When a counterexample is a real bug, add it as a plain example test next to the rule, so it is
checked on every run and not only when the generator finds it again.

## What it proves

### State machines, `tests/invariants/`

| Module                 | Rule                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/quota/ledger.ts`  | Spent and reserved always equal a plain account of what was reserved, settled, released and lapsed. Settle and release are idempotent. Ids are unique. Network limits hold.                                                       |
| `src/quota/ledger.ts`  | Spent plus reserved never exceeds the pool plus what settled runs cost above their reservation; with no run more than 5% above its reservation, never more than 5% above the pool.                                                |
| `src/quota/ledger.ts`  | A new month starts with nothing spent and only the reservations still held at that moment. A reservation that lapsed is charged to the month it was made in. A call stamped before midnight never reopens a month that has ended. |
| `src/llm/cost.ts`      | The reservation covers any real usage within the estimated tokens, on every candidate model, however the prompt splits between plain, cache-write and cache-read tokens.                                                          |
| `src/sessions/turn.ts` | Only the lease holder changes a session. One turn at a time. The owner never changes. The count never falls. A key that committed never runs again while it is remembered.                                                        |
| `src/quota/subject.ts` | The count never passes the limit, and a refund puts back exactly what the grant took.                                                                                                                                             |
| `src/llm/breaker.ts`   | A model is always offered, in the configured order, and an open one is skipped whenever another is closed.                                                                                                                        |
| `src/authn/device.ts`  | A challenge is handed out once and expires. A counter is accepted only if it grows.                                                                                                                                               |

### Parsers under hostile input, `tests/fuzz/`

- CBOR and DER readers answer any bytes with a value or `AppleFormatError`, never read outside the
  buffer, and refuse nesting deeper than sixteen levels instead of exhausting the stack.
- No change to a genuine attestation, assertion, store transaction or account token is ever read as
  a different key, counter, purchase or subject. Bytes that were never one are rejected.
- A certificate in a chain that parses but carries a key that cannot be decoded is a chain that
  does not hold, never a throw. `tests/apple/chain.test.ts` pins this case with a corrupted key, so
  it does not wait on a fuzz seed.
- An account token is answered with the claims its issuer signed or a 401, never a 500.
- Any request body is answered with a 400 or a conversation inside the tenant's limits, with no
  control characters and no tool the contract does not list.
- A fetch tool only resolves to an allowed host, over the template's scheme, with the template's
  number of path segments, and stops reading a source at its cap.
- The gated stream releases exactly the answer of an on-topic reply, nothing of an off-topic one,
  and the same text however the provider cuts the stream.

### Orderings, `tests/interleavings/`

`tests/support/interleave.ts` walks every ordering of a few actors' steps, including an actor that
stops part-way, and checks a rule at every state it reaches.

- **Pool.** Runs that reserve and then settle, settle twice, release or crash, with a clock that
  passes the two-minute hold and the hour a lapsed reservation is remembered: each run is charged
  once, and spent plus reserved stays within 5% of the pool.
- **Session.** A request, its retry under the same key, a request that fails, a key reused for
  another body and another owner, with a clock that passes the turn lease: a key commits at most
  once, a replay returns the body its key committed, no committed turn is lost or overwritten, and
  one owner's turns never share a session with another's.

## What it does not prove

- Anything about the Workers runtime, Durable Object storage, WebCrypto or the provider.
- That the model stays on topic or resists an instruction hidden in a document. That is bounded by
  the mechanisms these suites check: allowed hosts, pinned tools, quotas, the gate.
- The pool bound outside its conditions. It holds within one month, for runs that settle within
  the hour after their two-minute hold. A settlement that arrives later than that, after more than
  two thousand other reservations lapsed, or for a reservation made before this ledger was deployed,
  charges nothing beyond the reserve already counted, so a cost above the reserve is not recorded.
- Clocks that disagree. The ledger takes the time from the worker that calls it. A month never
  reopens, but a worker whose clock ran more than two minutes ahead would lapse live reservations
  early and refuse on `budget` until they settle. The orderings are explored on one clock.
- That the ledger's reference account is independent of it: it shares the hold and remember
  durations with the code, so a wrong duration would go unnoticed here.
- The pool bound when a run costs more than 5% above its reservation. The reservation assumes three
  characters per token; text that tokenises more densely than that can cost more than was reserved.
  Look at `spentNanoEur` against `poolNanoEur` on the dashboard after a tenant's first busy month.

## When you add a state machine or a parser

1. Write its rules down as sentences first: what can never happen, what is always put back, what
   an outsider can never change.
2. Add them to `tests/invariants/` as properties over random sequences of its operations, compared
   with the plainest account of the same thing you can write.
3. If two requests can reach it at once, or a caller can crash between two of its steps, add the
   steps to `tests/interleavings/`.
4. If it reads bytes or text from outside, add it to `tests/fuzz/`: any input gives a value or its
   own typed error, and a damaged genuine input is never read as a different genuine one.
5. Break the code on purpose once and see the suite fail. A rule that cannot fail proves nothing.
6. Add the rule to the tables above.
