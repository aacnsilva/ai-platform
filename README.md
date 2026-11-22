# agent-runtime

A multi-tenant agent runtime. It runs in production behind several products: each product is a tenant with its own callers, limits, tools and knowledge, and none of them shares state with another.

It is TypeScript on Cloudflare Workers, with Durable Objects for state. The runtime holds the mechanisms; everything specific to a product lives in that product's tenant document, outside this repository.

Because live products depend on it, a change is held to three things before it ships: `npm run check` passes, the change has its own verification (see [Working in this repository](#working-in-this-repository)), and it has run on the development deployment first.

## What it does

| Part          | Does                                                                                                                                                                                        | Does not do yet                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Gateway       | Tenant routing, three authenticators (anonymous by allowed origin, signed account token, attested device with a store purchase), plans and entitlement, CORS, input validation, admin token | Per-user admin accounts                                       |
| Quota         | Per-network limits, a monthly pool per tenant in EUR with reserve and settle, monthly messages per subject by plan                                                                          | Metering embedding calls                                      |
| LLM routing   | Capability tiers, a provider adapter for Anthropic, fallback before any text is written, a circuit breaker per model, cost metering                                                         | A second provider                                             |
| Agents        | A gated question-and-answer agent, and a chat agent with tools, in stateless or stored mode                                                                                                 | Runtime-issued approval prompts                               |
| Tools         | Contracts pinned by hash, tools that run on the client, read-only fetch tools behind an egress allowlist, knowledge search                                                                  | Code-mode sandbox, tools with side effects run by the runtime |
| Sessions      | Stored conversations as an append-only log with ownership, a lock per turn, idempotent retries, a transcript, deletion, and a tool loop with a round limit                                  |                                                               |
| Knowledge     | Per-tenant store, chunking, keyword and vector ranking, visibility per plan, document management                                                                                            | Reranking, very large corpora                                 |
| Observability | One record per request (codes and measurements only), aggregates, a dashboard                                                                                                               | Tracing, alerts                                               |

## Run it locally

You need Node 22.12 or later.

```bash
npm install
```

```bash
npm run demo
```

`npm run demo` starts a local worker with a fake model provider, loads the example tenant, sends a few requests, and prints the dashboard URL and its admin token. It needs no API key.

To talk to a real model, copy `.dev.vars.example` to `.dev.vars`, put a real key and a long random admin token in it, and run the worker:

```bash
npm run dev
```

Then add a tenant. Open `/admin/tenants`, sign in with the admin token and start from a template, or load the fictional example from the command line (real tenants live with their products, never in this repository):

```bash
curl -X PUT http://localhost:8787/admin/api/tenants/demo \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  --data @examples/tenants/demo.tenant.json
```

`npm run check` runs formatting, lint, types, unit tests and the end-to-end tests. The end-to-end tests boot a local worker themselves.

## Deploy

The runtime is one Cloudflare Worker. `wrangler.jsonc` defines two deployments that share the code and nothing else: each has its own stores, its own secrets and its own address.

| Deployment  | Command              | Worker name         |
| ----------- | -------------------- | ------------------- |
| Development | `npm run deploy:dev` | `agent-runtime-dev` |
| Production  | `npm run deploy`     | `agent-runtime`     |

You need a Cloudflare account. Log in once:

```bash
npx wrangler login
```

Deploy development first, and use it for anything unreleased and for eval runs. Production serves live products, so a change goes there only after it has run on development:

```bash
npm run deploy:dev
```

Wrangler prints the address, `https://agent-runtime-dev.<your-subdomain>.workers.dev`. The stores are created by the migration in `wrangler.jsonc`; there is no database to set up.

Give the deployment its secrets. Until they exist it is safe but inert: runs answer 503 `unconfigured` and the admin routes answer 503 `admin_unconfigured`.

```bash
openssl rand -hex 32
```

```bash
npx wrangler secret put ADMIN_TOKEN --env dev
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY --env dev
```

`EMBEDDINGS_BASE_URL` and `EMBEDDINGS_API_KEY` are secrets too, needed only when a tenant uses vector search.

Check it, then add a tenant from `/admin/tenants` or with the admin API:

```bash
curl https://agent-runtime-dev.<your-subdomain>.workers.dev/health
```

Production is the same without `--env dev`:

```bash
npm run deploy
```

```bash
npx wrangler secret put ADMIN_TOKEN
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

What production relies on:

- **Use a different admin token and a different model-provider key for each deployment.** Give each key its own spend limit at the provider, so there is a hard stop outside the runtime as well as the tenant pools inside it.
- **Restrict `/admin`.** The admin pages and API are protected by the admin token alone. Put an access policy in front of `/admin*`, such as Cloudflare Access, so only the people who should can reach them at all.
- **Keep eval runs on development.** A tenant with an `evals` block lets whoever holds its secret spend from its pool.
- **A deploy reaches every tenant at once.** There is one production Worker, and stored state (pools, sessions, quotas) outlives the code that wrote it. A change to a stored shape must read what the previous version stored.
- **A tenant belongs to one deployment.** Push a product's test tenant to development and its real one to production; nothing is copied between them.
- **Watch CPU time.** The free Workers plan allows 10 ms of CPU per request. Verifying a device attestation or a store purchase has not been measured against that; the paid plan removes the concern.

Deploys are manual. Nothing deploys from CI.

## API

| Route                                                                     | What it does                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/tenants/:id/runs`                                               | Run the tenant's agent. The body depends on the agent kind (below). Answers as JSON, or as server-sent events (`delta`, then one `done` or `error`) when the request sends `Accept: text/event-stream`. |
| `GET /v1/tenants/:id/status`                                              | `{ "accepting": true }` while the tenant's monthly pool has room.                                                                                                                                       |
| `GET` / `DELETE /v1/tenants/:id/sessions/:sessionId`                      | Read the transcript of a stored session, or delete it. Owner only.                                                                                                                                      |
| `POST /v1/tenants/:id/attest/challenge`, `/attest/key`                    | Enroll a device key for a tenant that authenticates attested devices.                                                                                                                                   |
| `GET` / `PUT` / `DELETE /admin/api/tenants/:id`, `GET /admin/api/tenants` | Read, save, delete and list tenants. Saving returns the hash of each tool contract.                                                                                                                     |
| `POST /admin/api/validate-tenant`                                         | Check a tenant document without saving it.                                                                                                                                                              |
| `GET /admin/api/templates`                                                | Starting documents for a new tenant.                                                                                                                                                                    |
| `GET` / `PUT` / `DELETE /admin/api/tenants/:id/documents[/:documentId]`   | Manage a tenant's knowledge documents.                                                                                                                                                                  |
| `GET /admin/api/metrics`                                                  | Aggregates for the dashboard.                                                                                                                                                                           |
| `GET /admin`                                                              | The dashboard.                                                                                                                                                                                          |
| `GET /admin/tenants`                                                      | The tenants pages: create and edit tenants, their plans and limits, tool contracts, knowledge documents and wording.                                                                                    |

Admin routes need the admin token. Errors are `{ "error": "<code>" }`, with a `message` and `retryAfterSeconds` where a person can act on them. Every response carries `x-request-id`.

### Request bodies

| Agent           | Body                                                                                                                                    | Reply                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Gated           | `{ "messages": [{ "role": "user", "content": "..." }] }`                                                                                | `{ "onTopic", "answer" }`                           |
| Chat, stateless | `{ "contractVersion", "context", "messages" }`, where the client sends the whole conversation including tool calls and results          | `{ "stopReason", "content", "quota" }`              |
| Chat, stored    | `{ "contractVersion", "context", "sessionId"?, "message" }`, or `"toolResults"` in place of `"message"` to answer a pending client tool | `{ "sessionId", "stopReason", "content", "quota" }` |

A chat client may send `contractHash`; the runtime refuses the request if the tenant's tools no longer match it.

### Turns on a stored session

- **One turn at a time.** A turn takes the session's lock before any model call. A second request on the same session gets `409 session_busy` with `Retry-After` at once, and nothing is paid for it. The lock is released when the turn ends, however it ends, and expires by itself if a worker dies holding it.
- **Retries.** Send `Idempotency-Key` (1 to 128 visible ASCII characters, new for each turn) with a turn. A repeat of the same request with the same key returns the stored reply with `Idempotent-Replay: true`: no model call, no message counted, nothing added to the conversation. A first turn sent without a `sessionId` gets a session derived from the subject and the key, so its retry lands on the same session. The same key with a different body is `422 idempotency_key_reused`; a key from an earlier turn is `409 idempotency_key_spent`. A retry that arrives while the first attempt is still running gets `session_busy`; retry again after `Retry-After`. Replies are kept only in the session's own store, so the key has no effect for stateless and gated agents.
- **History is a log.** Finished turns are appended and never rewritten or dropped; the transcript shows all of them. Only the copy sent to the model is trimmed, from the front in whole exchanges, to the agent's `input.maxMessages` and `input.maxConversationChars`, and to `input.maxConversationTokens` when the tenant sets it. Tokens are estimated from characters at the rate the provider's own usage figures gave for that session's last call.
- **Streams always end.** A stream ends on exactly one `done` or `error` event and is then closed, including when the runtime itself fails (`error: internal`). When the client goes away, the model call in flight is cancelled.

### Tenants

A tenant is one JSON document, validated by `src/tenants/schema.ts`. Two fictional examples show both shapes:

- `examples/tenants/demo.tenant.json`: anonymous callers, a gated agent.
- `examples/tenants/course.tenant.json`: signed account tokens, two plans, stored sessions, a fetch tool, knowledge search and a client tool.

Real tenants live with their products, never in this repository.

The runtime holds no product's rules. What differs between products is a tenant setting: how messages are counted, which prompt a contract version or client version gets, the wording of refusals and limits per language, which tools exist and where they run, which plans exist, and who may run evals.

## Evals

An eval suite asks a tenant real questions and grades what comes back, in code. `examples/evals/demo.cases.json` is a suite for the example tenant.

A tenant opts in with an `evals` block holding the SHA-256 of a secret of at least 32 characters. A runner that sends that secret is let in without an origin, a device or an account, gets its own subject per run and case, and receives a trace with each reply: the model, the model calls, the tools called and the cost. A tenant that serves production purchases cannot opt in.

```bash
EVAL_SECRET=... npm run evals -- --runtime http://localhost:8787 --tenant demo --cases examples/evals/demo.cases.json
```

The runner drives gated, stateless and stored tenants, answers client-run tools from the suite, prints the pass count per group and each failed check, compares against a saved baseline, and exits non-zero on a failure. `--runs 3` plays each case three times, `--tier` and `--effort` grade another model setting the tenant allows for evals. Real evals call the real model and cost money, so they are not part of `npm run check`.

Checks cover the tools called and what they were called with, the text and amounts of the answer, whether every amount of money came from a tool result or the question, the language, and time and model-call budgets. A case can attach one image.

A client that runs its own tools, such as a mobile app's test target, can use the same eval pass with its own runner: send `X-Eval-Secret` and `X-Eval-Run` in place of the usual credential.

## Working in this repository

`CLAUDE.md` has the ground rules: no comments in code, strict compiler and lint settings, nothing product-specific in `src/`, and every feature ships with unit tests, an end-to-end spec and a verification skill in `.claude/skills/`.

Three generated suites back the parts that money and access depend on, and run in `npm run check`:

- `tests/invariants/` plays random sequences of operations against the pool, sessions, quotas, pricing and the circuit breaker, and checks rules that must hold after every step.
- `tests/fuzz/` feeds hostile bytes and text to every parser of outside input: attestations, purchases, tokens, request bodies, fetch-tool arguments and the gated stream.
- `tests/interleavings/` walks every ordering of concurrent requests, retries, crashes and expired holds.

`.claude/skills/verify-invariants/` lists each rule, what the suites do not prove, and how to add a rule for a new state machine or parser.

## How it works

These diagrams show the runtime as it is built. Each has an editable source in [`docs/design`](docs/design): open the `.excalidraw` file at [excalidraw.com](https://excalidraw.com) or with the Excalidraw editor extension.

![Overview](docs/design/00-overview.png)

A request enters through the gateway, which finds the tenant, authenticates the caller and applies the tenant's limits. The tenant's agent then runs, calling the model through LLM routing, tools, and the tenant's knowledge store as it needs them.

### Tenants, subjects and plans

Each product is a tenant, each of its end customers is a subject, and each subject has a plan that sets its limits. The runtime does not own accounts or billing: a product proves who the subject is and which plan they have through its credential, and the runtime verifies the credential and enforces the plan.

### Gateway

![Gateway](docs/design/01-gateway.png)

- **Tenant route** finds the tenant document, cached for thirty seconds per worker instance.
- **Origin check** refuses a browser origin the tenant does not list.
- **Eval pass or authn plugin** verifies the caller. The plugin is chosen by the tenant: an attested device with a store purchase, a signed account token, or anonymous access by allowed origin.
- **Plan** maps the verified credential to one of the tenant's plans.
- **Validate and tool pin** checks the body for the tenant's agent kind and, when the client sends a contract hash, that its tools still match.
- **Pool reserve** holds the worst-case cost of the call against the tenant's monthly pool.
- **Message quota** counts the call against the subject's monthly messages, by the tenant's counting rule.

### Agents and evals

![Agents and evals](docs/design/05-agents-and-evals.png)

A tenant picks one of three agent kinds. Evals reach any of them through the eval pass, on tenants that opt in.

### Tools

![Tools](docs/design/02-tools-registry.png)

- **Contracts** are sets of tools per version, defined in the tenant document and hashed when it is saved.
- **Where a tool runs** is set per tool. A tool on the client may have any effect, because the client owns the confirmation. A tool the runtime runs must be read-only: a fetch from an allowed host, or a knowledge search.
- **Each model round** checks every call against the contract, hands client calls to the client, runs the rest, and loops up to the agent's round limit.

### LLM routing

![LLM routing](docs/design/03-llm-routing.png)

- **Before the call** the worst case is priced and reserved in the tenant's pool, and the candidates for the tier are ordered, skipping models whose circuit is open.
- **The circuit** for a model opens after three failures within a minute and pauses that model for thirty seconds; the first failure after the pause opens it again, and a success closes it. Only the provider being unavailable counts: a 5xx, a 429, a lost connection or a timeout. A request the provider refuses (other 4xx) or a caller who left does not. The state is kept in one Durable Object shared by every worker instance; an instance reads it when it starts, refreshes it in the background, and reports outcomes off the request path.
- **The call** is always streamed from the provider. It has twenty seconds to start and may then run as long as it keeps arriving; thirty seconds of silence ends it. It falls back to the next candidate only when nothing was written and nothing can have been billed. A timeout, or a failure after text began, is never retried and counts as spent. A call the client abandoned is cancelled and not retried.
- **After the call** the reserve is replaced by the real cost, once, however often the settlement arrives. A reserve nobody settled within two minutes is counted as spent, and corrected to the real cost if its run settles within the hour after. It is charged to the month it was made in; a run still held at midnight on the first carries into the new month. Spent plus reserved therefore stays within the pool, plus whatever a run cost above its own reserve; the reserve prices the prompt at the cache-write rate so that is rare, and the invariant suite holds the total to 5% above the pool within a month, when no run exceeds its reserve by more than that and runs settle within that hour.

### Knowledge

![Knowledge](docs/design/04-multi-tenant-rag.png)

- **Documents** are added through the admin API, chunked with their headings, and embedded when the tenant names an embedding model.
- **Each tenant has its own store.** No query can name another tenant.
- **Search** ranks by keyword and by vector, fuses the two, and returns passages with their source. A document restricted to plans is visible only to subjects on those plans.
