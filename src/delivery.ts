import crypto from "node:crypto";

/**
 * Outbound delivery: build the envelope, sign it, POST it to the Endpoint, and
 * map the outcome to a result the worker can act on.
 *
 * buildEnvelope is implemented. Signing and the HTTP call (timeout handling,
 * status→outcome mapping) are stubbed — these are step 2/3 and yours to write.
 */

import { config } from "./config";
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
 *HMAC-SHA256 over the raw body using the Endpoint
secret. Return the header value (e.g. `sha256=<hex>`); pair with a timestamp
 * header to prevent replay.
 */
export function signBody(rawBody: string, secret: string): string {
	return `sha256=${crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex")}`;
}

/** Outcome of a single Attempt, before it's classified into a Delivery status. */
export interface DeliveryResult {
	statusCode: number | null; // null when the request never completed (timeout/conn error)
	responseBody: string | null;
	error: string | null; // network/timeout error message, if any
	durationMs: number;
	retryAfterMs: number | null;
}

function parseRetryAfter(header: string | null): number | null {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return seconds * 1_000;
	const date = Date.parse(header);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - Date.now());
}

/**
 * POST the signed envelope to `endpoint.url` with config.requestTimeoutMs.
 * Capture status, a bounded slice of
 * the response body, any network/timeout error, and elapsed ms. Do NOT decide
 * retry-vs-fail here — that's the classifier's job X-Webhook-Signature(step 2).
 */
export async function deliverOne(
	endpoint: Endpoint,
	envelope: DeliveryEnvelope,
): Promise<DeliveryResult> {
	const result: DeliveryResult = {
		statusCode: null,
		responseBody: null,
		error: null,
		durationMs: 0,
		retryAfterMs: null,
	};
	const start = performance.now();

	try {
		const signature = signBody(JSON.stringify(envelope.data), endpoint.secret);
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			config.requestTimeoutMs,
		);
		const response = await fetch(endpoint.url, {
			method: "POST",
			body: JSON.stringify(envelope),
			signal: controller.signal,
			headers: {
				"X-Webhook-Signature": signature,
				"X-Webhook-Timestamp": new Date().toISOString(),
			},
		});
		clearTimeout(timeout);

		result.statusCode = response.status;
		result.responseBody = await response.text();
		result.retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
		result.durationMs = performance.now() - start;
	} catch (error) {
		result.error = String(error);
		result.durationMs = performance.now() - start;
	}

	return result;
}
