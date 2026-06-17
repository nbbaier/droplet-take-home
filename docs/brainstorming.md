# Requirements

These are the requirements we're going to have to hit:

- A way to register a new webhook URL.
- A way to ingest an event.
- When an event is ingested, invoke each registered webhook URL.
- A test harness to exercise the program. At minimum, it should generate and register webhook URLs and generate and feed events to your program to deliver to those URLs.
- Observability - logs, metrics, status API, a dashboard, or something totally different. Some way of telling how the system is behaving.
- A great solution will handle at least some production concerns. Think about retries, persistence, delivery guarantees, authentication, what happens when things fail in weird ways, etc.

# Brain dump

- Registering a webhook requires persistence => sqlite.
   - webhooks need to be debuggable locally, so we need to have some type of way of registering a local webhook that maybe runs on the same server?
- Will need a way to retrieve the registered endpoints from sqlite.
- Use Queue system to handle the delivery of the events to the webhook urls
- General flow when an event is ingested:
   - Event is validated and persisted to the database
   - For each webhook url, the an event_logs row is created, status pending
   - A worker loops through the event_logs and delivers the event to the webhook url, status sent
   - The worker stores the response from the webhook url in the event_logs row, status delivered or failed
- Processing the event:
   - Validation (need to decide on shape)
   - Persistence to the database
- DB schema:
   - webhooks: id, url, created_at, updated_at
   - events: id, data, created_at, updated_at
   - event_logs: id, event_id, webhook_id, status, response, created_at, updated_at
- Dashboard for the test harness/demonstration of functionlity.
- We'll have the following tabs at least for the dashboard:
   - webhook url management: list of urls with crud functionlity, persisted to the backend DB
      - some type of metric of events and whether they succeeded or not
   - event interface: an interface to fire an event and process them
   - event logs: was delivery successful, what was sent back, etc

## Tech stack

- vite with shadcn/ui for the frontend
- backend is hono + libsql for sqlite
