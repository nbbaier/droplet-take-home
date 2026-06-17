/**
 * The HTTP API. Thin handlers: validate with Zod, call the store, return JSON.
 * Routing/fan-out and delivery happen elsewhere; this layer just accepts input
 * and reports state.
 *
 * Wired so far: register Endpoint, ingest Event, list Endpoints/Deliveries.
 * Sink routes, the status/metrics endpoint, and delete are TODO (PLAN steps 3/5).
 */

import { Hono } from "hono";
import { fanOut } from "./fanout";
import { createEndpoint, listEndpoints } from "./store/endpoints";
import { createEvent } from "./store/events";
import { listDeliveries } from "./store/deliveries";
import { ingestSchema, registerEndpointSchema } from "./validation";

export const app = new Hono();

app.get("/", (c) => c.json({ service: "webhook-delivery", ok: true }));

/** Register an Endpoint pointing at an arbitrary external URL. */
app.post("/endpoints", async (c) => {
	const parsed = registerEndpointSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ error: "invalid_endpoint", details: parsed.error.flatten() }, 400);
	}
	const endpoint = await createEndpoint(parsed.data);
	// Secret is returned once, on creation.
	return c.json(endpoint, 201);
});

app.get("/endpoints", async (c) => c.json(await listEndpoints()));

/** Ingest an Event: validate, persist, fan out to matching Endpoints. */
app.post("/events", async (c) => {
	const parsed = ingestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ error: "invalid_event", details: parsed.error.flatten() }, 400);
	}
	const event = await createEvent(parsed.data);
	const deliveryCount = await fanOut(event);
	return c.json({ event, deliveryCount }, 202);
});

app.get("/deliveries", async (c) => c.json(await listDeliveries()));

// TODO (PLAN step 3): POST /sinks (create sink + auto-register endpoint),
//   POST /_sink/:id (the in-process receiver with configurable behavior).
// TODO (PLAN step 5): GET /status (computed-on-read metrics snapshot).
// TODO: DELETE /endpoints/:id (soft-delete + cancel its queued Deliveries).
