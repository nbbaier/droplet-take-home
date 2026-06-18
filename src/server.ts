/**
 * The HTTP API. Thin handlers: validate with Zod, call the store, return JSON.
 * Routing/fan-out and delivery happen elsewhere; this layer just accepts input
 * and reports state.
 *
 * Wired: register Endpoint, ingest Event, list Endpoints/Deliveries, create Sink,
 * and the in-process Sink receiver.
 */

import { Hono } from "hono";
import { config } from "./config";
import { fanOut } from "./fanout";
import { newId } from "./ids";
import { log } from "./shared";
import { behaviorResponse } from "./sinks";
import { listAttemptsForDelivery } from "./store/attempts";
import {
	cancelDeliveriesForEndpoint,
	getDelivery,
	listDeliveries,
} from "./store/deliveries";
import {
	createEndpoint,
	getEndpoint,
	listEndpoints,
	softDeleteEndpoint,
} from "./store/endpoints";
import { createEvent } from "./store/events";
import { getStatusSnapshot } from "./store/metrics";
import { createSink, getSink, incrementHits } from "./store/sinks";
import {
	createSinkSchema,
	ingestSchema,
	registerEndpointSchema,
} from "./validation";

export const app = new Hono();

app.get("/", (c) => c.json({ service: "webhook-delivery", ok: true }));

/** Register an Endpoint pointing at an arbitrary external URL. */
app.post("/endpoints", async (c) => {
	const parsed = registerEndpointSchema.safeParse(
		await c.req.json().catch(() => null),
	);
	if (!parsed.success) {
		return c.json(
			{ error: "invalid_endpoint", details: parsed.error.flatten() },
			400,
		);
	}
	const endpoint = await createEndpoint(parsed.data);

	return c.json(endpoint, 201);
});

app.get("/endpoints", async (c) => c.json(await listEndpoints()));

/** Ingest an Event: validate, persist, fan out to matching Endpoints. */
app.post("/events", async (c) => {
	const parsed = ingestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{ error: "invalid_event", details: parsed.error.flatten() },
			400,
		);
	}
	const event = await createEvent(parsed.data);
	log("event.ingested", { event_id: event.id, type: event.type });
	const deliveryCount = await fanOut(event);
	return c.json({ event, deliveryCount }, 202);
});

app.get("/deliveries", async (c) => c.json(await listDeliveries()));

/**
 * A single Delivery plus its full Attempt timeline (oldest first). Lets the
 * harness/CLI print the per-try retry timeline (status code per Attempt) without
 * touching the DB directly — the store already exposes both halves.
 */
app.get("/deliveries/:id", async (c) => {
	const id = c.req.param("id");
	const delivery = await getDelivery(id);
	if (!delivery) return c.json({ error: "delivery_not_found" }, 404);
	const attempts = await listAttemptsForDelivery(id);
	return c.json({ ...delivery, attempts });
});

/**
 * Create a Sink: mint its id up front, auto-register an Endpoint pointing back at
 * our own `/_sink/:id` route, then persist the Sink. Returns both.
 */
app.post("/sinks", async (c) => {
	const parsed = createSinkSchema.safeParse(
		await c.req.json().catch(() => null),
	);
	if (!parsed.success) {
		return c.json(
			{ error: "invalid_sink", details: parsed.error.flatten() },
			400,
		);
	}
	const sinkId = newId("sink");
	const url = `${config.publicBaseUrl}/_sink/${sinkId}`;
	const endpoint = await createEndpoint({
		url,
		eventTypes: parsed.data.eventTypes ?? ["*"],
	});
	const sink = await createSink(endpoint.id, parsed.data.behavior, sinkId);
	return c.json({ sink, endpoint }, 201);
});

/**
 * The in-process Sink receiver. Looks up the Sink, counts the hit, and returns
 * the configured Behavior's response (see sinks.ts).
 */
app.post("/_sink/:id", async (c) => {
	const id = c.req.param("id");
	const sink = await getSink(id);
	if (!sink) return c.json({ error: "sink_not_found" }, 404);

	const hits = await incrementHits(id);
	const endpoint = await getEndpoint(sink.endpointId);
	if (!endpoint) return c.json({ error: "sink_endpoint_missing" }, 500);

	// Pass the post-increment hit count so stateful behaviors see this request.
	return behaviorResponse({ ...sink, hits }, endpoint, c.req.raw);
});

app.delete("/endpoints/:id", async (c) => {
	const id = c.req.param("id");
	const endpoint = await getEndpoint(id);
	if (!endpoint) return c.json({ error: "endpoint_not_found" }, 404);
	await softDeleteEndpoint(id);
	await cancelDeliveriesForEndpoint(id);
	return c.body(null, 204);
});

/**
 * Metrics snapshot, computed on-read from the tables (no parallel counters).
 * Simple aggregations are real; windowed/statistical metrics are stubbed
 * placeholders (see src/store/metrics.ts) so this always returns 200 with a
 * complete shape. The `webhooks status` CLI renders this.
 */
app.get("/status", async (c) => {
	return c.json(await getStatusSnapshot());
});
