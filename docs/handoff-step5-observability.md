# Handoff: scaffold observability (PLAN step 5)

## Your task

Scaffold **PLAN.md step 5** ("Observability") for the webhook delivery service at
`/Users/nbbaier/Code/droplet-take-home`. Steps 1–4 are done (engine, retries,
signing, sinks, harness + tests). This is the last spine item. Three deliverables:

1. `GET /status` — a metrics snapshot **computed on-read** from the tables.
2. A minimal `webhooks status` CLI command that fetches and renders it.
3. **JSON-lines lifecycle logs** emitted by the daemon at key events.

A reviewing agent will check your work; the human implements whatever you stub.
Leave `bunx tsc --noEmit` and `bun test` green, and commit the scaffold.

## Read these first (source of truth — don't duplicate)

- `PLAN.md` step 5 — the exact metric list and log-event list.
- `docs/adr/0002-cli-over-http-api-no-dashboard.md` — observability is the CLI's
  job now (no dashboard); the `status` view and logs must carry it, so make them
  tasteful, not raw dumps. CLI/tools talk to the daemon over HTTP, never the DB.
- `CONTEXT.md` — glossary (Delivery statuses, Endpoint states, Attempt).
- `src/store/*.ts` — the data you aggregate. Mirror this store style for a new
  `src/store/metrics.ts`. Relevant columns: `deliveries(status, next_attempt_at,
updated_at, attempt_count)`, `attempts(duration_ms, status_code, created_at)`,
  `endpoints(state, deleted_at)`, `events`.
- `src/server.ts` — add `GET /status` here; also where `event.ingested` logs.
- `src/worker.ts`, `src/fanout.ts` — where most lifecycle logs are emitted.
- `src/config.ts` — add a logging knob (see below).
- `src/testing/bootstrap.ts` — set the log knob to silent in the test env (below).
- `AGENTS.md` — Bun conventions; `@libsql/client` (async).

## The scaffolding convention in this repo (IMPORTANT)

Implement mechanical parts for real; **stub the genuinely interesting logic** with
a clear marker + `// TODO (yours): ...`. For step 5:

**Implement fully:**

- `src/log.ts` — a tiny structured logger: `log(event: string, fields?: object)`
  writes one JSON line (`{ ts, event, ...fields }`) to stdout. Respect a level/
  silence knob so tests/harness aren't flooded (see config below). This is the
  whole logger — implement it.
- **All the enumerated log call sites** (mechanical, but they DO touch the engine —
  that's expected for this step; keep them to pure `log(...)` side-effect lines):
   - `event.ingested` — `POST /events` after `createEvent` (`event_id`, `type`).
   - `delivery.created` — in `fanOut` after each `createDelivery` (`delivery_id`,
     `event_id`, `endpoint_id`).
   - `attempt.started` / `attempt.succeeded` / `attempt.failed` — in `worker.ts`
     `processDelivery` around `deliverOne` (`delivery_id`, `attempt_number`,
     `status_code`, `duration_ms`).
   - `delivery.exhausted` — in `worker.ts` where retries run out → `markFailed`.
   - `endpoint.disabled` — in `worker.ts` `gone` case after `disableEndpoint`
     (`endpoint_id`).
     Every line must carry `delivery_id`/`event_id` where available so logs are
     correlatable.
- `src/store/metrics.ts` — the **simple** on-read aggregations:
   - `deliveryStatusCounts()` → counts by status (+ total).
   - `endpointStateCounts()` → active / disabled / deleted / total.
   - `inBackoffCount()` → `pending` rows with `next_attempt_at > now`.
   - `eventCount()` → total events.
- `getStatusSnapshot()` (in metrics.ts) assembling a `StatusSnapshot` from the
  simple parts above plus the stubbed advanced parts (below).
- `GET /status` route returning the snapshot as JSON.
- A `StatusSnapshot` type (full shape — define all fields, including the advanced
  ones the human will fill).
- A minimal `webhooks status` CLI: `src/cli/index.ts` (or similar) that fetches
  `GET <baseUrl>/status` (base URL from `config.publicBaseUrl` or a `--url` flag)
  and renders a basic readable summary. Add `"status": "bun run src/cli/index.ts
status"` (or a `webhooks` bin) to `package.json`. Implement the fetch + a basic
  render; leave the _polished_ formatting to the human (see stubs).
- `config.ts`: add a logging knob, e.g. `logLevel` from `LOG_LEVEL`
  (`"info"` default; `"silent"` suppresses output).
- `src/testing/bootstrap.ts`: set `process.env.LOG_LEVEL = "silent"` in the env
  block so `bun test`/harness runs aren't flooded with log lines.

**Stub for the human (return a clearly-marked PLACEHOLDER, do NOT throw — the
endpoint must still respond 200 so it's demoable; mark each with `// TODO`):**

- The **windowed/statistical metrics** — these involve real decisions (which
  timestamp defines the window, inclusive bounds, p95 with small N) that the human
  should own:
   - `recentThroughput(windowMs)` — deliveries reaching a terminal state within the
     window (use `deliveries.updated_at`).
   - `successRate(windowMs)` — delivered ÷ (delivered + failed) over the window.
   - `attemptLatencyPercentiles(windowMs)` — p50/p95 over `attempts.duration_ms`
     (SQLite has no percentile function — fetch durations and compute in JS).
   - `attemptsToSuccess()` — distribution/avg attempts for delivered deliveries.
     Stub each to return `null`/`0`/`[]` (typed per `StatusSnapshot`) with a TODO
     describing the exact computation. `getStatusSnapshot` wires them in so the shape
     is complete and the endpoint returns 200 with partial data.
- The **polished CLI rendering** — implement a basic dump, then leave a
  `// TODO (yours): nicer formatting` (aligned table / sections / colors). CLI
  taste is a deliberate human call here (it replaces the dashboard).

## Suggested shape (confirm against current code before writing)

```
src/
  log.ts                 — log(event, fields) → JSON line; honors config.logLevel
  store/metrics.ts       — simple aggregations + getStatusSnapshot (advanced stubbed)
  types.ts               — add StatusSnapshot (full shape)
  server.ts              — add GET /status; add event.ingested log
  fanout.ts              — add delivery.created log
  worker.ts              — add attempt.* / delivery.exhausted / endpoint.disabled logs
  config.ts              — add logLevel
  cli/index.ts           — `status` command: fetch GET /status + basic render
  testing/bootstrap.ts   — set LOG_LEVEL=silent in the env block
package.json             — add the status CLI script
test/                    — optional: a /status smoke test (200 + simple counts);
                           leave advanced-metric assertions as test.todo
```

## Constraints / gotchas

- Metrics are **computed on-read** with `GROUP BY`/filters — do NOT maintain a
  parallel counter system (avoids drift; this is a deliberate design choice).
- CLI/tools reach the daemon over HTTP only — never import the store/DB to read
  state (ADR 0002). The `status` CLI hits `GET /status`.
- Logs go to stdout as one JSON object per line. Keep fields flat and snake_case
  to match the event names. Do NOT log secrets (Endpoint `secret`, signatures).
- The logger MUST be silenceable (config.logLevel) and the test bootstrap MUST set
  it silent, or `bun test` output drowns in log lines.
- Engine edits in this step are limited to inserting `log(...)` call sites — do not
  change delivery/retry/claim/sink behavior.
- Run `bunx tsc --noEmit` and `bun test`; both must stay green (advanced-metric
  tests, if any, are `test.todo`).
- Commit the scaffold when green. Leave the stubbed metric math + CLI polish for
  the human.

## Definition of done

- `src/log.ts`, log call sites, `src/store/metrics.ts` (simple parts), `GET /status`,
  `StatusSnapshot` type, the `webhooks status` CLI (basic render), config knob, and
  the bootstrap silence-in-tests change — all implemented.
- Advanced metrics stubbed as typed placeholders with TODOs (endpoint returns 200).
- CLI polished rendering left as a TODO over a working basic render.
- `bunx tsc --noEmit` clean; `bun test` green.
- A short written summary: what you implemented vs stubbed, the `StatusSnapshot`
  shape, the logging knob name/default, and any deviations.

## Suggested skills

- None required. Follow the repo conventions above and prefer reading the existing
  store/server/worker files over guessing Bun/libsql APIs. (`hallmark`/`impeccable`
  are NOT needed — there's no GUI; CLI polish is plain text formatting.)
