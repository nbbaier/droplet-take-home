# Webhook Delivery Service

> A small, single-process webhook delivery service: register endpoints, ingest
> events, fan out, and deliver reliably with retries, signing, and observability.
>
> _TODO: 2–3 sentence framing in your own voice — what it is, what you chose to
> emphasize, and the headline (at-least-once delivery + a programmable test harness)._

---

## Quick start

- **Requirements:** [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`). No other infra.
- Install: `bun install`
- Run the daemon: `bun run dev` (API + worker, one process, on `:3000`)
   - or `bun run demo` for snappy retry timing (good for live demos)
- Run the test suite: `bun test`
- Drive a scenario (needs a daemon running): `bun run harness <scenario>`
- See system health: `bun run status`

Golden path (two terminals):

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

- One Bun process = Hono HTTP API + an in-process polling **worker**, over a single
  SQLite file (`@libsql/client`).
- Flow: `POST /events` → validate → persist Event → **fan out** one Delivery per
  matching Endpoint → worker **claims** due Deliveries → POSTs signed envelope →
  records an Attempt → marks delivered / reschedules / fails.
- _TODO: small ASCII flow diagram (event → deliveries → worker → endpoint)._
- Key design docs: [`CONTEXT.md`](./CONTEXT.md) (glossary),
  [`docs/adr/`](./docs/adr/) (decisions), [`PLAN.md`](./PLAN.md) (build log).

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

- **SQLite as the delivery queue** (no Redis/broker). Why: single binary, fully
  persistent, backoff = a `next_attempt_at` timestamp. See [ADR 0001](./docs/adr/0001-sqlite-as-delivery-queue.md).
   - Atomic claim with a `processing` state + **visibility-timeout reclaim** so a
     crash mid-flight doesn't strand a Delivery.
- **CLI + harness over the HTTP API; no web dashboard.** Why: focus the time on the
  delivery engine; observability lives in `status` + logs. See [ADR 0002](./docs/adr/0002-cli-over-http-api-no-dashboard.md).
- **Delivery guarantee: at-least-once.** Each Attempt carries a stable
  `X-Webhook-Id` so consumers can dedup (approximating exactly-once). _TODO: expand._
- **Typed routing.** Endpoints subscribe to a flat list of event types (`["*"]` =
  all); routing is **frozen at fan-out time**. _TODO: note fixed enum + future work._
- **Endpoint lifecycle:** soft-delete + a distinct `disabled` state; in-flight
  Deliveries become `canceled` (not `failed`). _TODO: expand the 3 scenarios._

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
- **Sinks** are programmable in-process receivers: `always-200`, `always-500`,
  `410-gone`, `slow`, `fail-then-recover`, `verify-signature`.
- Scenarios (each prints a delivery/attempt timeline + summary):
  `happy-path`, `retry-recovery`, `permanent-failure`, `gone-disables`,
  `delete-cancels`, `signature-verified`, `routing`.
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

✓ retry-recovery complete  —  run `webhooks status` to see the metrics
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
- _TODO: 2–3 lines on what you'd do next with more time, and any known limitations._

---

## LLM-assisted development

- _TODO: link/attach the session transcript(s)._
- _TODO: a few sentences on how you used the LLM — design grilling
  (CONTEXT.md/ADRs came out of it), scaffold-then-review loop, adversarial code
  review of generated code (e.g. it caught the HMAC-signed-wrong-bytes bug and the
  cancel race), and where you drove vs. delegated._

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
