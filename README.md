# Webhook Delivery Service

A single process webhook delivery service allowing users to register webhook endpoints, ingest events, deliver reliably with retries, HMAC signing and observability built in. The repo includes a harness that demonstrates a range of scenarios, including event type driven routing and success-after-failure scenarios.

---

## Quick start

- **Requirements:** [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`). No other infra.
- Install: `bun install`
- Run the test suite: `bun test`
- Run the daemon: `bun run dev` (API + worker, one process, on `:3000`)
   - or `bun run demo` for snappy retry timing (good for live demos)
- Use the demo harness to run a scenario (daemon must be running): `bun run harness <scenario>` (omit the name for an interactive menu)
- See system health: `bun run status`

Both `harness` and `status` require the HTTP server to be running.

```bash
# terminal 1 — start the daemon (snappy timing for a live demo)
bun install
bun run demo

# terminal 2 — drive a scenario against it, then check health
bun run harness retry-recovery
bun run status
```

---

## What it does (the requirements)

- [x] Register a webhook URL → `POST /endpoints`
- [x] Ingest an event → `POST /events`
- [x] Fan out: each ingested event is delivered to every matching endpoint
- [x] Test harness: generates endpoints + sinks, feeds events, prints results
- [x] Observability: `GET /status` metrics, `webhooks status` CLI, JSON-lines logs
- [x] Production concerns: retries + backoff, persistence, at-least-once delivery,
      HMAC signing, failure handling (timeouts, 410/4xx, endpoint deletion)

---

## Architecture (one paragraph + diagram)

One Bun process runs a Hono HTTP API and an in-process polling worker over a single
SQLite file (`@libsql/client`).

The flow is shown below: `POST /events` → validate → persist Event →
**fan out** one Delivery per matching Endpoint → worker **claims** due Deliveries →
POSTs a signed envelope → records an Attempt → marks delivered / reschedules / fails.

```
  POST /events                         worker tick (poll)
       │                                      │
       ▼                                      ▼
  ┌─────────┐  fan-out (routing locked   ┌──────────────────┐   atomic claim
  │  Event  │  at ingest, 1 per EP) ────▶│    Deliveries    │─────────────────┐
  └─────────┘                            │ pending/backoff  │                 │
                                         └──────────────────┘                 ▼
                                                                  ┌────────────┐
                                                                  │   Attempt  │
                                                                  │ HMAC POST  │
                                                                  └─────┬──────┘
                                                                        │
       ╭───╮                                                            ▼
       │   │  events in                                          ┌───────────┐
       ╰─╥─╯                                                     │ Endpoint  │
         ║                                                       │ or Sink   │
         ╚══════════════════════════════════════════════════════▶└───────────┘
```

More information can be found in the following design docs:

- [`CONTEXT.md`](./CONTEXT.md) (glossary)
- [`docs/adr/`](./docs/adr/) (decisions)
- [`PLAN.md`](./PLAN.md) (build log)

### Data model (4 + 1 tables)

- `endpoints` — a registered destination: URL, signing secret, subscribed event
  types, lifecycle state (`active`/`disabled`, soft-delete via `deleted_at`).
- `events` — an ingested event: type + opaque `data` payload.
- `deliveries` — one event headed to one endpoint; the unit the worker drains
  (status, attempt count, `next_attempt_at`, `claimed_at`).
- `attempts` — one HTTP try for a delivery (status code, error, duration) — the
  retry timeline.
- `sinks` — test-only in-process receivers with a configurable behavior.
- Terms are defined in [`CONTEXT.md`](./CONTEXT.md).

---

## Design decisions (the interesting choices)

- **SQLite as the delivery queue** (no Redis/broker). Why: SQLite is a single binary and fully
  persistent. See [ADR 0001](./docs/adr/0001-sqlite-as-delivery-queue.md).
- **CLI + harness over the HTTP API; no web dashboard.** Why: focus the time on the
  delivery engine; observability lives in `status` + logs. See [ADR 0002](./docs/adr/0002-cli-over-http-api-no-dashboard.md).
- **Delivery guarantee: at-least-once.** A Delivery stays eligible until it reaches a
  terminal state (`delivered`, `failed`, or `canceled`). Transient errors reschedule
  with backoff; a crash mid-Attempt leaves the row in `processing` until the
  visibility timeout reclaims it for another try. That means a consumer may see the
  same Event more than once — each Attempt sends `X-Webhook-Id` (the Event id,
  stable across retries) so receivers can dedupe and approximate exactly-once
  processing on their side.
- **Typed routing.** Event types are a fixed enum (`order.created`, `order.updated`,
  `order.deleted`, `payment.succeeded`, `payment.failed`). Endpoints subscribe to a
  flat list of those types, or `["*"]` for all — mixing `*` with specific types is
  rejected. Routing is **frozen at fan-out time**: once a Delivery exists, later
  subscription edits do not affect it. Future work: dynamic/registrable event types.
- **Endpoint lifecycle:** three paths to stop delivery without marking it "failed":
   1. **410 Gone** — the classifier treats this as permanent: the Delivery fails, the
      Endpoint flips to `disabled`, and any other queued Deliveries for that Endpoint
      are `canceled`. New events no longer fan out to it (`gone-disables` scenario).
   2. **Soft-delete** — `DELETE /endpoints/:id` sets `deleted_at` and cancels queued
      Deliveries. Rows stay for the audit trail (`delete-cancels` scenario).
   3. **Disabled vs deleted** — `disabled` is system-triggered (today: 410) and
      reversible; `deleted` is operator-initiated and terminal for that Endpoint.
      In both cases, in-flight work becomes `canceled`, not `failed` — nothing was
      wrong with the Delivery itself, the destination went away.

### Retry policy

- Success: `2xx`. Retry: `5xx`, `429`, `408`, timeouts, connection errors.
- Permanent fail: other `4xx`. `410 Gone` → fail **and disable the endpoint**.
- Honor `Retry-After` on `429`/`503` (capped at the backoff cap).
- Exponential backoff + jitter, **5 attempts**, then terminal `failed`.

### Signature contract (for consumers verifying webhooks)

- Header `X-Webhook-Signature: sha256=<hex>` = HMAC-SHA256 over
  `` `${X-Webhook-Timestamp}.${rawBody}` `` keyed by the endpoint's secret.
- To verify: recompute over the timestamp + the exact received body — **not** the
  body alone. Timestamp in the signed payload gives replay protection.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: string, headers: Headers, secret: string): boolean {
   const ts = headers.get("X-Webhook-Timestamp") ?? "";
   const got = headers.get("X-Webhook-Signature") ?? "";
   const want = `sha256=${createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")}`;
   const a = Buffer.from(got);
   const b = Buffer.from(want);
   return a.length === b.length && timingSafeEqual(a, b);
}
```

### Outbound delivery envelope

Each Attempt POSTs JSON to the Endpoint URL with these headers:

| Header                | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| `Content-Type`        | `application/json`                                       |
| `X-Webhook-Id`        | Event id (stable dedup key across retries)               |
| `X-Webhook-Timestamp` | ISO-8601 timestamp included in the signature             |
| `X-Webhook-Signature` | `sha256=<hex>` HMAC over `` `${timestamp}.${rawBody}` `` |

Body shape:

```json
{
   "id": "evt_<uuid>",
   "type": "order.created",
   "created_at": "2026-06-17T12:00:00.000Z",
   "data": { "orderId": "ord_1", "total": 42 }
}
```

---

## Configuration

Every timing knob is env-overridable (read once at startup). Defaults:

| Setting                     | Env                                         | Default                     | Notes                              |
| --------------------------- | ------------------------------------------- | --------------------------- | ---------------------------------- |
| HTTP request timeout        | `REQUEST_TIMEOUT_MS`                        | 10s                         | per Attempt                        |
| Visibility / reclaim        | `VISIBILITY_TIMEOUT_MS`                     | 30s                         | reclaim stranded `processing` rows |
| Worker concurrency          | `CONCURRENCY`                               | 10                          | max in-flight Attempts             |
| Poll interval               | `POLL_INTERVAL_MS`                          | 250ms                       | worker tick                        |
| Max attempts                | `MAX_ATTEMPTS`                              | 5                           | then `failed`                      |
| Backoff base / cap          | `BACKOFF_BASE_MS` / `BACKOFF_CAP_MS`        | 1s / 1h                     | `min(cap, base·2^n)` + jitter      |
| Response body cap           | `MAX_RESPONSE_BODY_CHARS`                   | 2048                        | stored per Attempt                 |
| Fail-then-recover threshold | `FAIL_THEN_RECOVER_THRESHOLD`               | 3                           | sink behavior                      |
| Slow sink delay             | `SINK_SLOW_DELAY_MS`                        | 15s                         | sink behavior                      |
| Log level                   | `LOG_LEVEL`                                 | info                        | `silent` suppresses logs           |
| DB / port / base URL        | `DATABASE_URL` / `PORT` / `PUBLIC_BASE_URL` | `file:./webhooks.db` / 3000 |                                    |

- `bun run demo` sets a snappy profile (`BACKOFF_BASE_MS=200`, low timeouts) so
  retries/cancels resolve in seconds for a live demo.

---

## HTTP API (reference)

- `POST /endpoints` — register an external URL `{ url, eventTypes }` → returns the
  endpoint incl. its secret (shown once).
- `GET /endpoints` · `DELETE /endpoints/:id` (soft-delete + cancel queued)
- `POST /events` — ingest `{ type, data }` → persists + fans out.
- `GET /deliveries` · `GET /deliveries/:id` (delivery + attempt timeline)
- `POST /sinks` — create an in-process test receiver with a behavior.
- `GET /status` — metrics snapshot (computed on-read).

```bash
# register an endpoint (returns its id + secret)
curl -s localhost:3000/endpoints \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hook","eventTypes":["order.created"]}'

# ingest an event → fans out to matching endpoints
curl -s localhost:3000/events \
  -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{"orderId":"ord_1","total":42}}'

# inspect
curl -s localhost:3000/deliveries
curl -s localhost:3000/status
```

---

## Test harness & scenarios

- The harness drives the **running daemon** over HTTP (so data persists and shows
  in `status`). `bun run harness` (menu) or `bun run harness <name>`.
- **Sinks** are programmable in-process receivers registered as Endpoints pointing
  at `POST /_sink/:id`:

| Behavior            | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `always-200`        | Immediate success                                     |
| `always-500`        | Permanent transient failure (retries until exhausted) |
| `fail-then-recover` | Returns 500 for the first N hits, then 200            |
| `410-gone`          | Permanent failure; disables the Endpoint              |
| `slow`              | Sleeps past the request timeout                       |
| `verify-signature`  | Recomputes the HMAC; returns 401 on mismatch          |

- Scenarios (each prints a delivery/attempt timeline + summary):
  `happy-path`, `retry-recovery`, `permanent-failure`, `gone-disables`,
  `delete-cancels`, `signature-verified`, `routing`.

   \_todo a table here with what the scenarios do

- `bun test` mirrors the scenarios 1:1 but **asserts** (scenarios print, tests
  assert; shared setup). Tests use an isolated temp daemon; the harness uses the
  real one.

Sample — `bun run harness retry-recovery` (transient 500s, then delivered):

```
▶ scenario: retry-recovery  (daemon @ http://localhost:3000)

retry-recovery: transient 500s, then delivered

  fanned out to 1 delivery(ies)
  delivery dlv_7dfae216-05b9-429b-8d65-99cff08adc3b
    status:        delivered
    attempt_count: 4
    attempts:
      #1  HTTP 500  (7.9ms)
      #2  HTTP 500  (1.7ms)
      #3  HTTP 500  (4.2ms)
      #4  HTTP 200  (3.3ms)
  summary: delivered=1

✓ retry-recovery complete  —  run `bun run status` to see the metrics
```

---

## Observability

- `GET /status` (and `bun run status`): queue depth by status, endpoint counts,
  in-backoff, events, windowed throughput + success rate. Computed on-read (no
  drift). Rendered (color in a real terminal):

```
webhook-delivery — degraded    2026-06-18 01:55:12

  ● 13 delivered   ● 3 pending   ● 0 in-flight   ● 2 failed   ● 0 canceled
  success 87%  ·  throughput 15 (last 300s)  ·  in-backoff 3  ·  events 6

Deliveries            Endpoints
  delivered     13      active        6
  pending        3      disabled      1
  in-flight      0      deleted       0
  failed         2      total         7
  canceled       0
  total         18
```

- JSON-lines lifecycle logs: `event.ingested`, `delivery.created`,
  `attempt.started/succeeded/failed`, `delivery.exhausted`, `endpoint.disabled` —
  correlatable by `delivery_id` / `event_id`.

---

## Scope & trade-offs

- **Descoped for time:** latency p50/p95 + attempts-to-success metrics; polished
  `--watch` live status; inbound API auth (open by design for the exercise).
- **Future work:** idempotency key on ingest, dynamic event types, separate worker
  process / real broker for horizontal scaling, broader auto-disable. See
  [`PLAN.md`](./PLAN.md).
- **With more time:** `webhooks status --watch` (live queue view), latency p50/p95
  and attempts-to-success from the `attempts` table (data is already stored),
  inbound API auth, and manual re-trigger of exhausted Deliveries.
- **Known limitations:** single writer process (SQLite throughput cap), fixed event
  type enum, open HTTP API (no auth — fine for a local exercise, not production).

---

## LLM-assisted development

This project was built in collaboration with Claude Code, predominantly in a single thread. I also used Cursor Tab completions and Cursor selection editing in some places.

My process with Claude was the following:

1. I read the assignment and do some early brainstorming in [`docs/brainstorming.md`](./docs/brainstorming.md).
2. I used an agent skill, `/grill-with-docs` (see below) to have Claude Code interview me on what I wanted to build, with reference to the assignment and brainstorming doc.
3. I then worked with Claude in a **scaffold-then-implement** loop: an agent stubs mechanical plumbing and leaves `// TODO (yours)` markers on the interesting bits; a human implements those interesting bit, and the agent and the human review the result. See the handoff notes in [`docs/handoff-*.md`](./docs/)

Some more specific notes on the process:

- **Design grilling** — back-and-forth on naming and guarantees produced
  [`CONTEXT.md`](./CONTEXT.md) (domain glossary) and the ADRs (SQLite-as-queue,
  CLI-over-API). [`PLAN.md`](./PLAN.md) is the ordered build log.
- **Where the human drove** — architecture calls (no dashboard, SQLite queue,
  at-least-once semantics, signature contract), implementing the worker/classifier/
  store layer, and deciding what to descope.
- **Where the LLM helped** — scaffolding harness scenarios, sink behaviors, metrics
  queries, and test setup; generating the initial Hono routes and Zod schemas.
- **Adversarial review** — a review pass by the agent caught real bugs before they shipped: the
  HMAC was initially signed over the wrong bytes (body alone instead of
  `` `${timestamp}.${body}` ``), and a cancel race could overwrite a `processing`
  Delivery after soft-delete.

I've included transcripts for the three sessions used to build this project in the `transcripts` directory. I used Simon Wilison's [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts) tool. The transcripts are:

1. [`1_main-thread`](./transcripts/1_main-thread/index.html): the main thread where I did the vast majority the LLM assisted coding.2.
2. [`2_step-4-handoff`](.transcripts/2_step-4-handoff/index.html): the thread where an agent scaffolded the code for step 4 of the [plan](./PLAN.md).
3. [`3_step-5-handoff`](.transcripts/3_step-5-handoff/index.html): the thread where an agent scaffolded the code for step 5 of the [plan](./PLAN.md).

I used two agent skills from [mattpocock/skills](https://github.com/mattpocock/skills) to help me during the project:

- `/grill-with-docs`: Initiates an interview that also helps builds the project's domain model, sharpening terminology and updating CONTEXT.md and ADRs inline.
- `/handoff`: Compacts the current conversation into a handoff document so another agent can continue the work

---

## Project layout

```
src/
  index.ts          daemon entrypoint (migrate → start worker → serve)
  server.ts         Hono HTTP API (endpoints, events, deliveries, sinks, status)
  worker.ts         polling worker: claim → deliver → classify → record
  fanout.ts         routing: one Delivery per matching Endpoint (frozen at ingest)
  delivery.ts       outbound HTTP + HMAC signing + envelope
  classifier.ts     response → retry / fail / gone / delivered + backoff
  sinks.ts          in-process test receivers (behaviors)
  config.ts         env-driven config object
  log.ts            JSON-lines structured logger
  ids.ts  types.ts  validation.ts
  db/               libsql client, schema.sql, migrate
  store/            data access: endpoints, events, deliveries, attempts, sinks, metrics
  harness/          scenario runner (client, scenarios, menu) — thin HTTP client
  cli/              `webhooks status` command
  testing/          isolated-daemon bootstrap for tests
test/               bun test suite (1:1 with scenarios)
docs/               ADRs, brainstorming, handoff notes
CONTEXT.md PLAN.md  glossary + build log
```
