# 1. SQLite as the delivery queue with an in-process polling worker

Date: 2026-06-17

## Status

Accepted

## Context

The service must deliver Events to Endpoints reliably (at-least-once), survive
restarts, and support retries with backoff. We need a mechanism that moves a
Delivery from `pending` to a terminal state and re-attempts on failure.

Options considered:

- **External broker** (Redis/BullMQ, RabbitMQ, SQS). Battle-tested queue
  semantics, but adds infrastructure a reviewer must stand up, and works against
  the goal of a single, locally-debuggable binary.
- **In-memory queue.** Trivial to write, but loses all in-flight Deliveries on
  restart — directly undercuts the persistence and delivery-guarantee goals.
- **SQLite as the queue.** The `deliveries` table *is* the queue. An in-process
  worker polls for due rows, claims them, delivers, and writes results back.

We are already using SQLite for persistence, the system is single-process, and
backoff maps naturally onto a `next_attempt_at` timestamp column.

## Decision

Use the `deliveries` table as the queue, driven by an **in-process polling
worker** started alongside the Hono server (one entrypoint).

Each tick the worker atomically claims a batch (`pending` rows that are due, plus
`processing` rows past a visibility timeout) by setting `status='processing'` and
`claimed_at=now`, delivers them concurrently (with a cap), and writes back the
outcome. Backoff is a future `next_attempt_at`. A **visibility timeout** reclaims
rows stranded in `processing` by a crash, preserving the at-least-once guarantee.

## Consequences

- No external infrastructure; `bun run dev` starts API + worker together.
- The queue is just a table — observability and the dashboard are plain `SELECT`s.
- Throughput is bounded by one process and SQLite write throughput. Acceptable for
  this assignment.
- **Future work:** the worker is a separate module that could run as its own
  entrypoint against the same DB for horizontal scaling; a real broker could be
  swapped in behind the same Delivery interface.
