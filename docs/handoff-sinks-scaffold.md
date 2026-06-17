# Handoff: scaffold the sinks subsystem

## Your task

Scaffold the **sinks subsystem** for the webhook delivery service at
`/Users/nbbaier/Code/droplet-take-home`. This is the remaining work in **PLAN.md
step 3** ("Signing + sinks") — signing is already done; sinks are not started.

A reviewing agent will check your work afterward, so be precise and leave the repo
typechecking cleanly (`bunx tsc --noEmit` must pass).

## Read these first (do not duplicate — they are the source of truth)

- `PLAN.md` — step 3 has the sink behavior list and the **signature contract** you
  must honor in the `verify-signature` stub. Also see the stack/config conventions.
- `CONTEXT.md` — glossary: **Sink** and **Sink Behavior** are already defined terms.
- `AGENTS.md` (== `CLAUDE.md`) — Bun conventions. Use `@libsql/client` (async API),
  not `bun:sqlite`. Use `node:crypto` for HMAC (already used in `src/delivery.ts`).
- Existing code to mirror for style/structure:
  - `src/store/endpoints.ts`, `src/store/events.ts` — the store pattern (row mappers,
    `db.execute({sql, args})`, ISO timestamps, prefixed IDs via `newId`).
  - `src/server.ts` — thin Hono handlers, Zod validation.
  - `src/types.ts` — `SinkBehavior` union already exists; add a `Sink` interface.
  - `src/config.ts`, `src/ids.ts`, `src/db/schema.sql`, `src/db/migrate.ts`.
  - `src/delivery.ts` — the signature construction the `verify-signature` sink must
    reconstruct: `sha256=<hex>` of `` `${timestamp}.${rawBody}` ``, secret = the
    Endpoint's secret, timestamp from the `X-Webhook-Timestamp` header.

## The established scaffolding convention in this repo (IMPORTANT)

The human wants scaffolds, not finished features. **Implement** the simple/mechanical
parts for real; **stub** the genuinely interesting logic with a clear
`throw new Error("... not implemented")` and a `// TODO (yours): ...` comment that
explains what to do. Match the existing stub style in `src/fanout.ts` /
`src/worker.ts` history (see `git log`).

Specifically for sinks:

- **Implement fully:** the `sinks` table DDL, `Sink` type, `src/store/sinks.ts` CRUD
  (`createSink`, `getSink`, `incrementHits`, `listSinks`), a `config.publicBaseUrl`
  (`http://localhost:<port>`), `POST /sinks` (generate id → `createEndpoint` pointing
  at `/_sink/:id` → `createSink`, return the sink + endpoint), the `POST /_sink/:id`
  route wiring + hit increment + dispatch, and the **trivial behaviors**:
  `always-200`, `always-500`, `410-gone`, `slow` (use `config` for the slow delay).
- **Stub for the human (throw + TODO):**
  - `fail-then-recover` — needs a fail-count threshold compared against the sink's
    `hits`; leave the threshold semantics to the human.
  - `verify-signature` — recompute the HMAC per the contract above and return 200 vs
    401; leave the exact verification to the human (note: it needs the Endpoint's
    secret, looked up via the sink's `endpoint_id`).

## Proposed shape (confirm against current code before writing)

```
src/
  store/sinks.ts   — sinks table CRUD (implemented)
  sinks.ts         — behaviorResponse(sink, endpoint, req): Response — switch on
                     behavior; trivial cases implemented, two cases stubbed
  server.ts        — add POST /sinks and POST /_sink/:id
  db/schema.sql    — add `sinks` table: id, endpoint_id, behavior, hits, created_at
  config.ts        — add publicBaseUrl + any slow-behavior delay knob
  types.ts         — add Sink interface (SinkBehavior already exists)
```

Note: `sinks` is a **5th table** (the original design had 4). That's fine — it's test
infrastructure — but call it out in your summary so the reviewer isn't surprised.

## Constraints / gotchas

- Do NOT touch the delivery engine, classifier, or worker — sinks only.
- libsql is **async**; every store call is `await`ed.
- IDs are `<prefix>_<uuid>` via `newId`. Pick a sink prefix (e.g. add `sink` to
  `ID_PREFIX` in `src/ids.ts` — that's an allowed implemented change).
- Timestamps are ISO-8601 UTC strings (`new Date().toISOString()`).
- Keep handlers thin; validate request bodies with Zod (add a schema to
  `src/validation.ts`, e.g. `createSinkSchema` with a `behavior` enum + optional
  `eventTypes`).
- Run `bunx tsc --noEmit` and fix any type errors before finishing.
- Do NOT commit — leave changes in the working tree for review. Do NOT run the
  full daemon (the worker logs errors on an empty-ish DB is fine, but not needed).

## Definition of done

- New/changed files match the shape above; trivial behaviors implemented; the two
  named behaviors stubbed with TODOs; `tsc` clean.
- A short written summary of what you implemented vs stubbed, any deviations from
  the proposed shape, and the 5th-table note.

## Suggested skills

- None required. This is a scaffolding task; follow the repo conventions above.
  (If you find yourself unsure about Bun/libsql APIs, prefer reading the existing
  store files over guessing.)
