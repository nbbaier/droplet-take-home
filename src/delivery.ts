/**
 * Outbound delivery: build the envelope, sign it, POST it to the Endpoint, and
 * map the outcome to a result the worker can act on.
 *
 * buildEnvelope is implemented. Signing and the HTTP call (timeout handling,
 * status→outcome mapping) are stubbed — these are step 2/3 and yours to write.
 */

import type { DeliveryEnvelope, Endpoint, Event } from "./types";

/** The exact object serialized into the request body. Signature covers this JSON. */
export function buildEnvelope(event: Event): DeliveryEnvelope {
	return {
		id: event.id, // Event id: stable across retries; the consumer's dedup key
		type: event.type,
		created_at: event.createdAt,
		data: event.data,
	};
}

/**
 * TODO (yours — PLAN step 3): HMAC-SHA256 over the raw body using the Endpoint
 * secret. Return the header value (e.g. `sha256=<hex>`); pair with a timestamp
 * header to prevent replay.
 */
export function signBody(_rawBody: string, _secret: string): string {
	throw new Error("signBody not implemented");
}

/** Outcome of a single Attempt, before it's classified into a Delivery status. */
export interface DeliveryResult {
	statusCode: number | null; // null when the request never completed (timeout/conn error)
	responseBody: string | null;
	error: string | null; // network/timeout error message, if any
	durationMs: number;
}

/**
 * TODO (yours — PLAN step 1 happy path, then 3): POST the signed envelope to
 * `endpoint.url` with config.requestTimeoutMs. Capture status, a bounded slice of
 * the response body, any network/timeout error, and elapsed ms. Do NOT decide
 * retry-vs-fail here — that's the classifier's job (step 2).
 */
export async function deliverOne(_endpoint: Endpoint, _envelope: DeliveryEnvelope): Promise<DeliveryResult> {
	throw new Error("deliverOne not implemented");
}
