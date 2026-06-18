/**
 * The delivery worker: a poll loop that claims due Deliveries and dispatches them
 * to be delivered, bounded by config.concurrency. Started alongside the server
 * (one process) and stopped on shutdown.
 *
 * The lifecycle (start/stop/tick scheduling) is scaffolded. The actual per-tick
 * work — claim → deliver → classify → record Attempt → update Delivery (retry vs
 * terminal) — is stubbed for you (PLAN steps 1–2). This is the orchestration core.
 */

import { classifyResult, computeBackoffMs, shouldRetry } from "./classifier";
import { config } from "./config";
import { buildEnvelope, deliverOne } from "./delivery";
import { log } from "./shared";
import { recordAttempt } from "./store/attempts";
import {
	cancelDeliveriesForEndpoint,
	cancelDelivery,
	claimBatch,
	markDelivered,
	markFailed,
	rescheduleDelivery,
} from "./store/deliveries";
import { disableEndpoint, getEndpoint } from "./store/endpoints";
import { getEvent } from "./store/events";
import type { Delivery } from "./types";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function processDelivery(delivery: Delivery): Promise<void> {
	const event = await getEvent(delivery.eventId);
	if (!event) throw new Error(`Event not found: ${delivery.eventId}`);

	const endpoint = await getEndpoint(delivery.endpointId);
	if (
		!endpoint ||
		endpoint.deletedAt ||
		endpoint.disabledAt ||
		endpoint.state === "disabled"
	) {
		await cancelDelivery(delivery.id);
		return;
	}

	const attemptNumber = delivery.attemptCount + 1;
	const envelope = buildEnvelope(event);
	log("attempt.started", {
		delivery_id: delivery.id,
		event_id: delivery.eventId,
		endpoint_id: delivery.endpointId,
		attempt_number: attemptNumber,
	});
	const result = await deliverOne(endpoint, envelope);
	await recordAttempt({
		deliveryId: delivery.id,
		attemptNumber,
		statusCode: result.statusCode,
		responseBody: result.responseBody,
		error: result.error,
		durationMs: result.durationMs,
	});

	const outcome = classifyResult(result);

	const attemptResultFields = {
		delivery_id: delivery.id,
		event_id: delivery.eventId,
		endpoint_id: delivery.endpointId,
		attempt_number: attemptNumber,
		status_code: result.statusCode,
		duration_ms: result.durationMs,
	};

	switch (outcome.action) {
		case "delivered":
			log("attempt.succeeded", attemptResultFields);
			await markDelivered(delivery.id);
			break;
		case "failed":
			log("attempt.failed", attemptResultFields);
			await markFailed(delivery.id);
			break;
		case "gone":
			log("attempt.failed", attemptResultFields);
			await markFailed(delivery.id);
			await disableEndpoint(delivery.endpointId);
			log("endpoint.disabled", { endpoint_id: delivery.endpointId });
			await cancelDeliveriesForEndpoint(delivery.endpointId);
			break;
		case "retry":
			log("attempt.failed", attemptResultFields);
			if (shouldRetry(delivery.attemptCount, outcome)) {
				const delayMs =
					outcome.retryAfterMs ?? computeBackoffMs(delivery.attemptCount + 1);
				const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
				await rescheduleDelivery(delivery.id, nextAttemptAt);
			} else {
				log("delivery.exhausted", {
					delivery_id: delivery.id,
					event_id: delivery.eventId,
					endpoint_id: delivery.endpointId,
					attempt_number: attemptNumber,
				});
				await markFailed(delivery.id);
			}
			break;
		default: {
			const _exhaustive: never = outcome;
			throw new Error(`Unknown outcome: ${JSON.stringify(_exhaustive)}`);
		}
	}
}

/**
 * one pass of work.
 *  1. claimBatch(config.claimBatchSize)
 *  2. for each claimed Delivery (respect config.concurrency):
 *     - load Event + Endpoint; if Endpoint deleted/disabled → cancel
 *     - buildEnvelope → deliverOne → recordAttempt
 *     - classify result → markDelivered | reschedule w/ backoff | markFailed
 */
async function tick(): Promise<void> {
	const deliveries = await claimBatch(config.claimBatchSize);
	if (deliveries.length === 0) return;

	let index = 0;
	const workerCount = Math.min(config.concurrency, deliveries.length);

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			for (;;) {
				const i = index++;
				const delivery = deliveries[i];
				if (!delivery) break;
				await processDelivery(delivery);
			}
		}),
	);
}

export function startWorker(): void {
	if (running) return;
	running = true;

	const loop = async () => {
		if (!running) return;
		try {
			await tick();
		} catch (err) {
			console.error(
				JSON.stringify({ log: "worker.tick.error", error: String(err) }),
			);
		}
		if (running) timer = setTimeout(loop, config.pollIntervalMs);
	};

	loop();
}

export function stopWorker(): void {
	running = false;
	if (timer) clearTimeout(timer);
	timer = null;
}
