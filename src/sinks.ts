/**
 * Sink behavior dispatch. Given a Sink (already hit-incremented), its owning
 * Endpoint, and the incoming request, produce the Response the in-process
 * receiver should return — exercising a delivery failure mode on demand.
 *
 * All behaviors are implemented. The two with the most logic:
 * `fail-then-recover` (stateful — uses the Sink's hit count) and
 * `verify-signature` (recomputes the HMAC over `${timestamp}.${rawBody}`).
 */

import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { signBody } from "./delivery";
import type { Endpoint, Sink } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Compute the Response for a single hit on `sink`.
 *
 * @param sink     the Sink, with `hits` already incremented for this request
 * @param endpoint the Endpoint that owns this Sink (carries the signing secret)
 * @param req      the inbound request (raw body + headers for signature checks)
 */
export async function behaviorResponse(
	sink: Sink,
	endpoint: Endpoint,
	req: Request,
): Promise<Response> {
	switch (sink.behavior) {
		case "always-200":
			return new Response("ok", { status: 200 });

		case "always-500":
			return new Response("internal sink error", { status: 500 });

		case "410-gone":
			// Exercises the classifier's permanent-failure + Endpoint-disable path.
			return new Response("gone", { status: 410 });

		case "slow":
			// Stalls long enough to trip the per-Attempt request timeout.
			await sleep(config.sinkSlowDelayMs);
			return new Response("slow ok", { status: 200 });

		case "fail-then-recover":
			// Return 500 for the first N hits, then 200, so the worker
			// retries and eventually succeeds. Use `sink.hits` (already incremented
			// for this request) against a fail-count threshold.
			// Fail-count threshold defined in config.failThenRecoverThreshold

			if (sink.hits <= config.failThenRecoverThreshold) {
				return new Response("internal sink error", { status: 500 });
			}
			return new Response("ok", { status: 200 });

		case "verify-signature": {
			const rawBody = await req.text();
			const timestamp = req.headers.get("X-Webhook-Timestamp");
			const signature = req.headers.get("X-Webhook-Signature");

			if (!timestamp || !signature) {
				return new Response("Missing signature headers", { status: 401 });
			}

			const signedPayload = `${timestamp}.${rawBody}`;
			const expectedSignature = signBody(signedPayload, endpoint.secret);
			const provided = Buffer.from(signature, "utf8");
			const expected = Buffer.from(expectedSignature, "utf8");

			if (
				provided.length !== expected.length ||
				!timingSafeEqual(provided, expected)
			) {
				return new Response("Invalid signature", { status: 401 });
			}

			return new Response("OK", { status: 200 });
		}

		default: {
			// Exhaustiveness guard: a new SinkBehavior must be handled above.
			const _never: never = sink.behavior;
			return new Response(`unknown behavior: ${_never}`, { status: 500 });
		}
	}
}
