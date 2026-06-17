/**
 * Sink behavior dispatch. Given a Sink (already hit-incremented), its owning
 * Endpoint, and the incoming request, produce the Response the in-process
 * receiver should return — exercising a delivery failure mode on demand.
 *
 * The trivial behaviors are implemented. The two stateful/cryptographic ones
 * (`fail-then-recover`, `verify-signature`) are scaffolded: they throw with a
 * TODO so the human can fill in the interesting logic.
 */

import { config } from "./config";
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
			// TODO (yours): return 500 for the first N hits, then 200, so the worker
			// retries and eventually succeeds. Use `sink.hits` (already incremented
			// for this request) against a fail-count threshold — decide the threshold
			// semantics (config knob? fixed? compare `<=` vs `<`?) and wire it here.
			throw new Error("fail-then-recover sink behavior not implemented");

		case "verify-signature":
			// TODO (yours): verify the HMAC and return 200 (valid) or 401 (invalid).
			// Reconstruct the signed payload exactly per the contract in delivery.ts:
			//   signedPayload = `${X-Webhook-Timestamp header}.${raw request body}`
			//   expected = signBody(signedPayload, endpoint.secret)  // "sha256=<hex>"
			// then compare against the `X-Webhook-Signature` header (use a constant-
			// time compare, e.g. node:crypto timingSafeEqual). `endpoint.secret` is
			// the secret to use — this Endpoint was looked up via sink.endpoint_id.
			throw new Error("verify-signature sink behavior not implemented");

		default: {
			// Exhaustiveness guard: a new SinkBehavior must be handled above.
			const _never: never = sink.behavior;
			return new Response(`unknown behavior: ${_never}`, { status: 500 });
		}
	}
}
