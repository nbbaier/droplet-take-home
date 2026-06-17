# 2. CLI + harness over the HTTP API; no web dashboard

Date: 2026-06-17

## Status

Accepted

## Context

The assignment requires a way to register endpoints, ingest events, a test
harness, and observability. It explicitly allows the interface to be "an HTTP API,
a CLI harness, or some other interesting idea," and allows observability to be
"logs, metrics, status API, a dashboard, or something totally different."

An initial plan included a Vite + shadcn/ui dashboard with tabs and action
buttons. Within a 2–6 hour budget, a polished frontend is the highest
effort-per-point item and the most likely to be left half-finished — which the
rubric penalizes more than a deliberately narrower scope.

## Decision

Cut the web dashboard. Build:

- **One daemon** (`bun run dev`): Hono serving the ingest API, sink routes, the
  status/metrics API, and the in-process worker.
- **A CLI** that is a *thin client over the HTTP API* — never touching SQLite
  directly. Commands to add endpoints, create sinks, emit events, list
  deliveries/attempts, and show status.
- **A harness script** that drives the same HTTP API to run end-to-end scenarios
  and print a report.
- **Observability** = structured JSON logs from the daemon, a status/metrics JSON
  endpoint, and a `status --watch` CLI view.

The CLI talks to the API, not the database, so there is a single writer (the
daemon owns the DB), and the CLI, harness, and any external consumer all exercise
the same surface.

## Consequences

- Removes the largest time sink; effort concentrates on the delivery engine,
  reliability, and tests — the heart of the assignment.
- The "where do you invest in UX polish?" signal moves to the CLI and status
  output, which must therefore be genuinely polished (e.g. a live `--watch` view),
  not raw dumps.
- No direct-DB CLI path avoids two writers to one SQLite file and split-brain.
- **Future work:** the status/metrics API is UI-ready, so a dashboard could be
  added later without changing the core.
