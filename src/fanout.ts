/**
 * Fan-out: when an Event is ingested, create one Delivery per matching active
 * Endpoint. Routing is decided HERE, once — frozen at fan-out time, never
 * re-evaluated on later attempts (see CONTEXT.md / PLAN edge cases).
 *
 * The orchestration is wired; the `matches` predicate is left to you (exact-match
 * + the `*` wildcard semantics).
 */

import { createDelivery } from "./store/deliveries";
import { listActiveEndpoints } from "./store/endpoints";
import type { Endpoint, Event } from "./types";

/**
 * Does `endpoint` want `eventType`?
 * - `["*"]` → matches every type
 * - otherwise → exact membership in the array
 */
export function matches(endpoint: Endpoint, eventType: Event["type"]): boolean {
	if (endpoint.eventTypes.length === 1 && endpoint.eventTypes[0] === "*") {
		return true;
	}
	return endpoint.eventTypes.some((t) => t === eventType);
}

/** Create Deliveries for every active Endpoint subscribed to this Event's type. */
export async function fanOut(event: Event): Promise<number> {
	const endpoints = await listActiveEndpoints();
	const targets = endpoints.filter((e) => matches(e, event.type));
	await Promise.all(targets.map((e) => createDelivery(event.id, e.id)));
	return targets.length;
}
