# Build Plan — Webhook Delivery Service

Companion to [`CONTEXT.md`](./CONTEXT.md) (domain glossary) and
[`docs/adr/`](./docs/adr/) (architecture decisions). This file is the build order
and checklist. Build the spine top-to-bottom so there is always a working,
demoable system at each cut line.

## Stack

- Bun + Hono (one daemon: API + sink routes + status API + worker).
- `@libsql/client` for persistence (async API — all DB calls are `await`ed). Zod
  for validation. No other deps unless needed.
- CLI + harness are thin HTTP clients of the daemon — never touch the DB directly.

## Config object (document prominently in README)

One central config so demo delays can be shrunk:

| Setting                      | Default          | Notes                                                         |
| ---------------------------- | ---------------- | ------------------------------------------------------------- |
| HTTP request timeout         | 10s              | per Attempt                                                   |
| Visibility / reclaim timeout | 30s              | reclaim stranded `processing` rows                            |
| Worker concurrency cap       | ~10              | max in-flight Attempts                                        |
| Poll interval                | 250ms            | worker tick                                                   |
| Max attempts                 | 5                | then `failed`                                                 |
| Backoff base / cap           | base 1s, cap ~1h | `min(cap, base * 2^attempt)` + jitter; tiny base in demo mode |

## Schema (4 tables)

- `endpoints` — id (`ep_<uuid>`), url, secret, event_types (JSON array), state
  (`active`/`disabled`), disabled_at, deleted_at, created_at, updated_at.
- `events` — id (`evt_<uuid>`), type, data (JSON), created_at.
- `deliveries` — id (`dlv_<uuid>`), event_id, endpoint_id, status
  (`pending`/`processing`/`delivered`/`failed`/`canceled`), attempt_count,
  next_attempt_at, claimed_at, created_at, updated_at.
- `attempts` — id (`att_<uuid>`), delivery_id, attempt_number, status_code,
  response_body, error, duration_ms, created_at.

## Build order (the spine)

### 1. Happy path, end to end

- [x] Schema + migrations + config object.
- [x] ID helper (`prefix_<uuid>`), Zod schemas for ingest + endpoint registration.
- [x] `POST /endpoints` (register external URL, generate secret, validate event_types).
- [x] `POST /events` (validate `{type, data}` against enum, persist, fan out one
      Delivery per matching active Endpoint — routing frozen here).
- [x] Worker: poll → claim batch → POST envelope → mark `delivered`/`failed`
      (now includes retries — see step 2).
- [x] Delivered envelope `{id, type, created_at, data}` + headers.

### 2. Retries + backoff + classification ⚠️ bug-prone

- [x] **Retry classifier** (own module): 2xx success; 5xx/429/408/
      timeout/conn-error → retry; 410 → permanent + disable Endpoint; other 4xx →
      permanent fail. Honor `Retry-After` on 429/503 (capped at backoff cap).
- [x] Backoff → `next_attempt_at`; increment `attempt_count`; `failed` at cap.
- [x] **Claim query**: atomically take due `pending` rows AND
      `processing` rows past visibility timeout; set `processing` + `claimed_at`.

### 3. Signing + sinks

- [x] HMAC-SHA256 signature; `X-Webhook-Signature` + `X-Webhook-Timestamp` +
      `X-Webhook-Id` headers. **Signature contract** (implemented in
      `delivery.ts`): the signed payload is `` `${timestamp}.${rawBody}` `` where
      `timestamp` is the `X-Webhook-Timestamp` header value and `rawBody` is the
      exact JSON bytes of the request body. Header value is `sha256=<hex>`.
      To verify, a receiver MUST recompute over `` `${X-Webhook-Timestamp}.${body}` ``
      with its Endpoint secret — NOT over the body alone. (Stripe-style; the
      timestamp in the signed payload is what gives replay protection.)
- [ ] In-process sink routes `POST /_sink/:id` with Behaviors: always-200,
      fail-then-recover, always-500, slow/timeout, 410-gone, verify-signature.
      (The `verify-signature` sink must reconstruct `timestamp.body` per the
      contract above.)
- [ ] `POST /sinks` — create sink with chosen behavior, auto-register Endpoint
      pointing at it, return id.

### 4. Harness + tests (the evidence)

- [ ] Shared setup helpers: `registerEndpoint`, `createSink`, `emitEvent`,
      `waitForSettled`.
- [ ] Named scenarios (run + print timeline + status snapshot): `happy-path`,
      `retry-recovery`, `permanent-failure`, `gone-disables`, `delete-cancels`,
      `signature-verified`, `routing`.
- [ ] Harness entry: no arg → interactive menu; `bun run harness <name>` → run one.
- [ ] `bun test` 1:1 with scenarios (shared setup; tests assert, scenarios print).

### 5. Observability

- [ ] Status/metrics endpoint (computed on-read): queue depth by status,
      throughput (last 1/5 min), success rate, retry health (in-backoff count +
      attempts-to-success), latency p50/p95, endpoint counts (incl. disabled).
- [ ] `webhooks status` CLI command rendering it.
- [ ] JSON-lines lifecycle logs: `event.ingested`, `delivery.created`,
      `attempt.started/succeeded/failed`, `delivery.exhausted`, `endpoint.disabled`,
      correlatable by delivery_id/event_id.

### Edge-case behaviors (fold into steps above)

- [~] Endpoint soft-delete → in-flight Deliveries → `canceled` (not `failed`).
      (Worker cancels deliveries for deleted/disabled Endpoints; store fn exists.
      Still needs the `DELETE /endpoints/:id` route + proactive cancel.)
- [x] 410 → Endpoint `disabled`; queued Deliveries `canceled`; no new fan-out.
- [x] Routing frozen at fan-out (subscription changes don't affect existing Deliveries).

## CLI commands

`endpoint add <url> --types ...`, `sink create --behavior ...`,
`emit <type> --data ...`, `deliveries list`, `status`.

## Stretch goals (only if spine is done)

- [ ] `webhooks status --watch` live view.
- [ ] Manual re-trigger of a `failed` Delivery.

## Future work (name in README, don't build)

- Idempotency key on ingest.
- Inbound API auth / multi-tenancy (currently open by design).
- Dynamic/registrable event types.
- Separate worker entrypoint / real broker for horizontal scaling.
- 410 auto-disable already done; broader auto-disable on repeated failures.

## README must include

- How to run (daemon, CLI, harness, tests).
- Design decisions + delivery guarantee (at-least-once + dedup header).
- The **signature verification contract** (sign/verify over
  `` `${X-Webhook-Timestamp}.${body}` ``, `sha256=<hex>`) so consumers can verify.
- The config object and how to shrink delays for demos.
- Link to ADRs and CONTEXT.md.
- LLM session transcripts.
- ASCII pipe illustration (per spec easter egg).
