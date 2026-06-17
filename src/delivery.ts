import crypto from "node:crypto";

/**
 * Outbound delivery: build the envelope, sign it, POST it to the Endpoint, and
 * map the outcome to a result the worker can act on.
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
 * HMAC-SHA256 over `signedPayload` using the Endpoint secret, returned as
 * `sha256=<hex>`. The caller signs the exact bytes sent (timestamp + raw body),
 * so the receiver can recompute the same value and verify authenticity + freshness.
 */
export function signBody(signedPayload: string, secret: string): string {
	return `sha256=${crypto
		.createHmac("sha256", secret)
		.update(signedPayload)
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
 * Captures status, a bounded slice of the response body, any network/timeout
 * error, and elapsed ms. Does NOT decide retry-vs-fail — that's the classifier's
 * job (step 2).
 *
 * The signature covers `${timestamp}.${rawBody}` — the exact bytes sent — so the
 * receiver verifies over what it actually received and can reject stale requests.
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

	const rawBody = JSON.stringify(envelope);
	const timestamp = new Date().toISOString();
	const signature = signBody(`${timestamp}.${rawBody}`, endpoint.secret);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

	try {
		const response = await fetch(endpoint.url, {
			method: "POST",
			body: rawBody,
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				"X-Webhook-Id": envelope.id,
				"X-Webhook-Signature": signature,
				"X-Webhook-Timestamp": timestamp,
			},
		});

		result.statusCode = response.status;
		result.retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
		// Read the body while the timeout is still armed, then truncate what we store.
		const body = await response.text();
		result.responseBody = body.slice(0, config.maxResponseBodyChars);
	} catch (error) {
		result.error = String(error);
	} finally {
		clearTimeout(timeout);
		result.durationMs = performance.now() - start;
	}

	return result;
}
