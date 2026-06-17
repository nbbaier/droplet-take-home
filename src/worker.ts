/**
 * The delivery worker: a poll loop that claims due Deliveries and dispatches them
 * to be delivered, bounded by config.concurrency. Started alongside the server
 * (one process) and stopped on shutdown.
 *
 * The lifecycle (start/stop/tick scheduling) is scaffolded. The actual per-tick
 * work — claim → deliver → classify → record Attempt → update Delivery (retry vs
 * terminal) — is stubbed for you (PLAN steps 1–2). This is the orchestration core.
 */

import { config } from "./config";

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * TODO (yours): one pass of work.
 *  1. claimBatch(config.claimBatchSize)
 *  2. for each claimed Delivery (respect config.concurrency):
 *     - load Event + Endpoint; if Endpoint deleted/disabled → cancel
 *     - buildEnvelope → deliverOne → recordAttempt
 *     - classify result → markDelivered | reschedule w/ backoff | markFailed
 */
async function tick(): Promise<void> {
	throw new Error("worker tick not implemented");
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
