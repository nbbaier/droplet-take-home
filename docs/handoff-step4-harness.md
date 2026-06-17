# Handoff: scaffold the test harness + `bun test` scenarios (PLAN step 4)

## Your task

Scaffold **PLAN.md step 4** ("Harness + tests — the evidence") for the webhook
delivery service at `/Users/nbbaier/Code/droplet-take-home`. Steps 1–3 are done
(engine, retries, signing, sinks). This step builds the thing that *demonstrates
and proves* the system works.

A reviewing agent will check your work, and a human will implement whatever you
stub. Leave the repo typechecking cleanly (`bunx tsc --noEmit`) and committed.

## Read these first (source of truth — don't duplicate)

- `PLAN.md` step 4 — the scenario list and the harness shape (menu + `bun run
  harness <name>`; `bun test` 1:1 with scenarios; tests assert, scenarios print).
- `docs/adr/0002-cli-over-http-api-no-dashboard.md` — **the harness/CLI are thin
  HTTP clients of the daemon. They must NOT touch the DB directly.** This is a hard
  constraint.
- `CONTEXT.md` — glossary (Endpoint, Event, Delivery, Attempt, Sink, statuses).
- `src/server.ts` — the existing HTTP API you'll drive: `POST /endpoints`,
  `GET /endpoints`, `POST /events`, `GET /deliveries`, `POST /sinks`,
  `POST /_sink/:id`.
- `src/sinks.ts` + `src/types.ts` (`SinkBehavior`) — the sink behaviors the
  scenarios exercise (`always-200`, `fail-then-recover`, `always-500`, `slow`,
  `410-gone`, `verify-signature`).
- `src/config.ts` — every timing knob is env-overridable; tests/harness shrink
  delays via env (see "demo-fast config" below).
- `src/worker.ts`, `src/classifier.ts`, `src/store/*` — for understanding behavior;
  do NOT modify the engine.
- `AGENTS.md` — Bun conventions; `bun test` from `bun:test`; `@libsql/client`.

## The scaffolding convention in this repo (IMPORTANT)

Implement the mechanical/plumbing parts for real; **stub the genuinely interesting
logic** with `throw new Error("... not implemented")` + a `// TODO (yours): ...`
comment describing exactly what to do. The human owns the interesting bits.

For step 4 the split is:

**Implement fully (plumbing the human shouldn't have to write):**
- A **test/harness bootstrap** that starts an isolated daemon (app + worker) on an
  ephemeral port against a throwaway DB, with demo-fast config, and returns
  `{ baseUrl, stop() }`. This is the load-bearing piece — see "Key challenge".
- **HTTP client helpers** (thin wrappers over `fetch`):
  `registerEndpoint(baseUrl, {url, eventTypes})`, `createSink(baseUrl, {behavior,
  eventTypes?})`, `emitEvent(baseUrl, {type, data})`, `listDeliveries(baseUrl)`,
  `getDeliveryWithAttempts(baseUrl, id)`, and `waitForSettled(baseUrl, {timeout})`
  that polls `GET /deliveries` until deliveries reach a terminal state or timeout.
- A **small read endpoint to expose Attempts** so scenarios can print the retry
  timeline: add `GET /deliveries/:id` to `src/server.ts` returning the Delivery
  plus its Attempts (the store already has `listAttemptsForDelivery` and
  `getDelivery`). `attempt_count` is already on `GET /deliveries`, but the per-try
  timeline (status codes per attempt) needs this. This is allowed plumbing.
- The **harness entry/dispatcher**: `bun run harness` (no arg) → interactive menu
  listing scenarios; `bun run harness <name>` → run one and exit. Add the script to
  `package.json`. The harness should spin up its own bootstrap daemon so it's
  self-contained (`bun run harness retry-recovery` just works).
- **One fully-worked reference scenario end-to-end**: `happy-path` — its scenario
  function (setup → emit → waitForSettled → print delivery/attempt timeline) AND
  its `bun test` case (same setup, hard assertions). This is the template the human
  copies for the rest.

**Stub for the human (throw + TODO, with a comment describing setup + assertion):**
- The remaining scenario functions: `retry-recovery`, `permanent-failure`,
  `gone-disables`, `delete-cancels`, `signature-verified`, `routing`. Each stub's
  comment should state what to set up and what to assert. Examples to put in the
  TODOs:
  - `retry-recovery`: fresh `fail-then-recover` sink → emit → assert delivery ends
    `delivered` with `attempt_count === 4` (3×500 then 200). NOTE: use a FRESH sink
    (hits are per-sink, not per-delivery).
  - `permanent-failure`: `always-500` sink → assert ends `failed` after exactly
    `maxAttempts` attempts.
  - `gone-disables`: `410-gone` sink → assert delivery `failed`, Endpoint
    `disabled`, no new fan-out.
  - `signature-verified`: `verify-signature` sink → assert `delivered` (valid sig);
    optionally a tampered variant.
  - `routing`: endpoints with disjoint `event_types` + one `["*"]` → emit one type →
    assert only matching endpoints got Deliveries.
- The matching `bun test` cases for the stubbed scenarios: use `test.todo(...)` or a
  skipped test with a comment, so the suite is green but the gaps are visible.

**Blocked / call out explicitly:**
- `delete-cancels` depends on `DELETE /endpoints/:id`, which does NOT exist yet
  (PLAN edge-case `[~]`). Do NOT build that route (out of scope). Stub the scenario
  with a TODO noting it's blocked on the DELETE route.

## Key challenge: isolated daemon for tests (read carefully)

`src/config.ts` reads `DATABASE_URL`/`PORT` from env **at import time** into a
frozen object, and `src/db/client.ts` creates the libsql client at import time.
So to run an isolated instance you must set env BEFORE those modules are imported.
Recommended approach for the bootstrap helper:

```ts
// set env first, THEN dynamically import modules that read config
process.env.DATABASE_URL = `file:./.tmp-harness-<unique>.db`;
process.env.PORT = "0";                 // ephemeral
process.env.BACKOFF_BASE_MS = "10";     // demo-fast
process.env.VISIBILITY_TIMEOUT_MS = "1000";
process.env.SINK_SLOW_DELAY_MS = "200"; // so 'slow' trips a small REQUEST_TIMEOUT_MS
process.env.REQUEST_TIMEOUT_MS = "100";
const { app } = await import("../server");
const { startWorker, stopWorker } = await import("../worker");
const { migrate } = await import("../db/migrate");
await migrate();
const server = Bun.serve({ port: 0, fetch: app.fetch });
startWorker();
return { baseUrl: `http://localhost:${server.port}`, async stop() { stopWorker(); server.stop(true); /* rm temp db */ } };
```

Implications to honor:
- Test files must NOT statically `import` from `src/server`/`src/config` before the
  bootstrap sets env (a static import locks config early). Import the bootstrap
  only, and let it dynamic-import the rest. Pick a unique temp DB name per
  bootstrap so parallel test files don't collide; delete it on `stop()`.
- ALWAYS `stop()` (stopWorker + server.stop) in `afterAll`/`finally`, or the worker
  poll loop and server keep the process alive and `bun test` hangs.
- If `:memory:` is simpler and works with the single shared client, you may use it —
  but verify the worker and API see the same data (same process, same client
  singleton). A temp file is the safe default.

## Suggested file shape (confirm against current code before writing)

```
src/
  testing/bootstrap.ts   — startTestDaemon(): { baseUrl, stop } (dynamic-import pattern)
  harness/client.ts      — HTTP client helpers + waitForSettled
  harness/scenarios.ts   — scenario registry: name -> async (baseUrl) => void
                           (happy-path implemented; rest stubbed w/ TODO)
  harness/index.ts       — entry: menu (no arg) / dispatch <name>; spins up bootstrap
  server.ts              — add GET /deliveries/:id (delivery + attempts)
test/ (or *.test.ts)
  scenarios.test.ts      — happy-path asserted; others test.todo
package.json             — add "harness": "bun run src/harness/index.ts"
```

## Constraints / gotchas

- Do NOT modify the delivery engine, classifier, worker, or sink behaviors.
- Harness/tests talk to the API over HTTP only — never import the store/db to read
  state (ADR 0002). The new `GET /deliveries/:id` is how you read Attempts.
- `bun test` from `bun:test`. Run it and `bunx tsc --noEmit`; both must pass (the
  stubbed scenarios should be `test.todo`, not failing tests).
- Scenarios PRINT (human-readable timeline + a status-ish summary from the data you
  have); tests ASSERT. Share setup helpers; don't fork logic.
- Do NOT build `GET /status` (that's step 5) — derive any printed summary from
  `GET /deliveries`.
- Commit the scaffold when tsc + `bun test` are green. Leave stubs for the human.

## Definition of done

- Bootstrap + client helpers + `GET /deliveries/:id` + harness entry implemented.
- `happy-path` scenario AND its asserted test fully working (the template).
- Other scenarios stubbed with descriptive TODOs; their tests `test.todo`.
- `delete-cancels` stubbed with the "blocked on DELETE /endpoints/:id" note.
- `bunx tsc --noEmit` clean; `bun test` green (todos don't fail).
- A short written summary: what you implemented vs stubbed, the bootstrap approach
  you chose (temp file vs `:memory:`), the new endpoint, and any deviations.

## Suggested skills

- `tdd` — optional, if you want the red-green loop while wiring the `happy-path`
  reference test. Otherwise none required; follow the repo conventions above and
  prefer reading existing files over guessing Bun/libsql APIs.
