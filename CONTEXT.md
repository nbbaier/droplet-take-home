# Context

A glossary of the domain language for the webhook delivery service. Implementation
details do not belong here — only the meaning of terms.

## Glossary

### Endpoint
A registered destination for events: a URL plus its configuration (e.g. secret,
which events it wants). Persisted; created when a caller registers a destination.
Chosen over "Subscription" and over the overloaded term "webhook".

### Event
Something that happened, ingested into the system. Gets validated and persisted,
then fanned out to matching Endpoints. Carries an Event Type.

### Event Type
A string identifying what kind of Event this is, in `resource.action` form. Drawn
from a fixed, system-defined set — validated against a known list, not stored as
data. (Future work: make the set dynamic/registrable.)

The set: `order.created`, `order.updated`, `order.deleted`, `payment.succeeded`,
`payment.failed`.

### Sink
A built-in, in-process receiver used for testing and demos. Reachable at a local
route and registered as an Endpoint pointing at itself. Created with a chosen
Behavior so failure modes can be exercised on demand. Distinct from an Endpoint
that points at an arbitrary external URL the user supplies.

### Sink Behavior
The configured response pattern of a Sink — e.g. always-200, fail-then-recover,
always-500, slow/timeout, 410-gone, verify-signature. Chosen when the Sink is
created; lets the harness and dashboard demonstrate retries, backoff, permanent
failure, and signature checking.

### Routing
An Endpoint subscribes to a flat array of Event Types. An Event is delivered to an
Endpoint only if the Event's Type is in that array. The literal `*` in an Endpoint's
array means "all Event Types". Matching is exact (no globbing beyond `*`).

### Delivery
One Event headed to one Endpoint. The unit we track and retry. Has a status and a
retry count. One Event ingested with N matching Endpoints produces N Deliveries.

Delivery status values:
- **pending** — waiting to be attempted (or waiting out backoff).
- **processing** — claimed by the worker, attempt in flight.
- **delivered** — terminal; an Attempt succeeded (2xx).
- **failed** — terminal; retries exhausted or a permanent error (e.g. 4xx).
- **canceled** — terminal; the target Endpoint was deleted or disabled before
  delivery. Nothing *failed* — distinct from `failed`.

### Endpoint states
- **active** — receives fan-out and is delivered to.
- **disabled** — turned off by the system (e.g. after a 410 Gone). Reversible. No
  new Deliveries are created; queued ones are canceled.
- **deleted** — soft-deleted by an operator (`deleted_at` set). Rows are retained
  for the audit trail; queued Deliveries are canceled.

Routing is frozen at fan-out time: a Delivery, once created, is unaffected by later
changes to the Endpoint's subscribed Event Types.

### Attempt
A single HTTP request made in service of a Delivery. A Delivery may have multiple
Attempts (retries). Carries the response status/body of that one try.

### Secret
A per-Endpoint shared secret, generated when the Endpoint is registered and
returned to the caller once. Used to sign outbound Attempts so the receiver can
verify authenticity.

### Signature
A keyed hash (HMAC-SHA256) of an Attempt's raw request body, computed with the
Endpoint's Secret and sent as a header alongside a timestamp. The receiver
recomputes it to confirm the request came from us and was not replayed.

## Avoid
- **"webhook"** as a noun — it conflates Endpoint, Delivery, and Attempt. Use the
  precise term instead.
