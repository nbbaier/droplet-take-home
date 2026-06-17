import { config } from "./config";
import type { DeliveryResult } from "./delivery";

export type DeliveryOutcome =
	| { action: "delivered" }
	| { action: "retry"; retryAfterMs?: number }
	| { action: "failed" }
	| { action: "gone" };

export function classifyResult(result: DeliveryResult): DeliveryOutcome {
	if (result.statusCode === null) return { action: "retry" };

	const code = result.statusCode;

	if (code >= 200 && code < 300) return { action: "delivered" };
	if (code === 410) return { action: "gone" };

	if (code === 429 || code === 408 || code === 503 || code >= 500) {
		// Honor Retry-After only on 429/503 (per design), and never let it exceed
		// the backoff cap — a hostile/buggy endpoint shouldn't pin a Delivery for days.
		const honorsRetryAfter = code === 429 || code === 503;
		const retryAfterMs =
			honorsRetryAfter && result.retryAfterMs !== null
				? Math.min(config.backoffCapMs, result.retryAfterMs)
				: undefined;
		return { action: "retry", retryAfterMs };
	}

	if (code >= 400 && code < 500) {
		return { action: "failed" };
	}

	return { action: "retry" };
}

export function computeBackoffMs(completedAttemptNumber: number): number {
	const exponential =
		config.backoffBaseMs * 2 ** Math.max(0, completedAttemptNumber - 1);
	const capped = Math.min(config.backoffCapMs, exponential);
	const jitter = Math.floor(Math.random() * config.backoffBaseMs);
	return capped + jitter;
}

export function shouldRetry(
	attemptCount: number,
	outcome: DeliveryOutcome,
): outcome is { action: "retry"; retryAfterMs?: number } {
	if (outcome.action !== "retry") return false;
	return attemptCount + 1 < config.maxAttempts;
}
