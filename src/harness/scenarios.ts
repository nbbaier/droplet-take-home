/**
 * Scenario registry: name -> async (baseUrl) => void. Each scenario drives the
 * daemon over HTTP (via ./client) and PRINTS a human-readable timeline + a small
 * status summary derived from GET /deliveries (NOT a status endpoint — that's
 * PLAN step 5). The matching `bun test` cases ASSERT the same setup; share these
 * helpers, don't fork the logic.
 *
 * `happy-path` is fully worked as the reference template. Keep the print/assert
 * split — scenarios print, tests assert.
 */

import {
	createSink,
	deliveriesFor,
	emitEvent,
	getDeliveryWithAttempts,
	listEndpoints,
	waitForSettled,
} from "./client";

export type Scenario = (baseUrl: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Shared print helpers (used by scenarios; tests assert on the same data shape).
// ---------------------------------------------------------------------------

/** Print a Delivery's per-Attempt timeline: one line per try, status code/error. */
async function printDeliveryTimeline(
	baseUrl: string,
	deliveryId: string,
): Promise<void> {
	const d = await getDeliveryWithAttempts(baseUrl, deliveryId);
	console.log(`  delivery ${d.id}`);
	console.log(`    status:        ${d.status}`);
	console.log(`    attempt_count: ${d.attemptCount}`);
	if (d.attempts.length === 0) {
		console.log(`    attempts:      (none)`);
		return;
	}
	console.log(`    attempts:`);
	for (const a of d.attempts) {
		const outcome =
			a.statusCode !== null ? `HTTP ${a.statusCode}` : `error: ${a.error}`;
		console.log(`      #${a.attemptNumber}  ${outcome}  (${a.durationMs}ms)`);
	}
}

/** Print a one-line status tally across all settled Deliveries. */
function printStatusSummary(
	deliveries: Array<{ status: string }>,
	label = "summary",
): void {
	const tally: Record<string, number> = {};
	for (const d of deliveries) tally[d.status] = (tally[d.status] ?? 0) + 1;
	const parts = Object.entries(tally).map(([s, n]) => `${s}=${n}`);
	console.log(`  ${label}: ${parts.join(", ") || "(no deliveries)"}`);
}

const happyPath: Scenario = async (baseUrl) => {
	console.log("happy-path: healthy endpoint, delivered on first try\n");

	const { endpoint } = await createSink(baseUrl, { behavior: "always-200" });
	const { deliveryCount } = await emitEvent(baseUrl, {
		type: "order.created",
		data: { orderId: "ord_1", total: 42 },
	});
	console.log(`  fanned out to ${deliveryCount} delivery(ies)`);

	const settled = await waitForSettled(baseUrl, {
		endpointId: endpoint.id,
		expectedCount: 1,
	});
	for (const d of settled) await printDeliveryTimeline(baseUrl, d.id);
	printStatusSummary(settled);
};

const retryRecovery: Scenario = async (baseUrl) => {
	console.log("retry-recovery: transient 500s, then delivered\n");

	const { endpoint } = await createSink(baseUrl, {
		behavior: "fail-then-recover",
	});
	const { deliveryCount } = await emitEvent(baseUrl, {
		type: "payment.succeeded",
		data: { paymentId: "pay_1", amount: 42 },
	});
	console.log(`  fanned out to ${deliveryCount} delivery(ies)`);

	const settled = await waitForSettled(baseUrl, {
		endpointId: endpoint.id,
		expectedCount: 1,
	});
	for (const d of settled) await printDeliveryTimeline(baseUrl, d.id);
	printStatusSummary(settled);
};

const permanentFailure: Scenario = async (baseUrl) => {
	console.log("permanent-failure: always-500, retries exhausted\n");

	const { endpoint } = await createSink(baseUrl, { behavior: "always-500" });
	const { deliveryCount } = await emitEvent(baseUrl, {
		type: "payment.failed",
		data: { paymentId: "pay_1", amount: 42 },
	});
	console.log(`  fanned out to ${deliveryCount} delivery(ies)`);

	const settled = await waitForSettled(baseUrl, {
		endpointId: endpoint.id,
		expectedCount: 1,
	});
	for (const d of settled) await printDeliveryTimeline(baseUrl, d.id);
	printStatusSummary(settled);
};

const goneDisables: Scenario = async (baseUrl) => {
	console.log("gone-disables: 410 disables the endpoint\n");

	const { endpoint } = await createSink(baseUrl, { behavior: "410-gone" });
	const { deliveryCount } = await emitEvent(baseUrl, {
		type: "order.created",
		data: { orderId: "ord_gone", total: 99 },
	});
	console.log(`  fanned out to ${deliveryCount} delivery(ies)`);

	const settled = await waitForSettled(baseUrl, {
		endpointId: endpoint.id,
		expectedCount: 1,
	});
	for (const d of settled) await printDeliveryTimeline(baseUrl, d.id);
	printStatusSummary(settled);

	const endpoints = await listEndpoints(baseUrl);
	const ep = endpoints.find((e) => e.id === endpoint.id);
	console.log(`  endpoint ${endpoint.id}: state=${ep?.state ?? "unknown"}`);

	const beforeSecond = (await deliveriesFor(baseUrl, endpoint.id)).length;
	const { deliveryCount: secondCount } = await emitEvent(baseUrl, {
		type: "order.created",
		data: { orderId: "ord_gone_2", total: 100 },
	});
	const afterSecond = (await deliveriesFor(baseUrl, endpoint.id)).length;
	console.log(
		`  second emit: deliveryCount=${secondCount}, endpoint deliveries ${beforeSecond} → ${afterSecond}`,
	);
};

const deleteCancels: Scenario = async (baseUrl) => {
	console.log(
		"delete-cancels: deleting an endpoint cancels its in-flight deliveries\n",
	);

	const { endpoint } = await createSink(baseUrl, { behavior: "slow" });
	const { deliveryCount } = await emitEvent(baseUrl, {
		type: "order.created",
		data: { orderId: "ord_delete", total: 100 },
	});
	console.log(`  fanned out to ${deliveryCount} delivery(ies)`);

	const deleteRes = await fetch(`${baseUrl}/endpoints/${endpoint.id}`, {
		method: "DELETE",
	});
	console.log(`  deleted endpoint ${endpoint.id}: HTTP ${deleteRes.status}`);

	const settled = await waitForSettled(baseUrl, {
		endpointId: endpoint.id,
		expectedCount: 1,
	});
	for (const d of settled) await printDeliveryTimeline(baseUrl, d.id);
	printStatusSummary(settled);
};

const signatureVerified: Scenario = async (baseUrl) => {
	console.log("signature-verified: valid HMAC accepted\n");

	const { endpoint } = await createSink(baseUrl, {
		behavior: "verify-signature",
	});
	const { deliveryCount } = await emitEvent(baseUrl, {
		type: "order.created",
		data: { orderId: "ord_sig", total: 55 },
	});
	console.log(`  fanned out to ${deliveryCount} delivery(ies)`);

	const settled = await waitForSettled(baseUrl, {
		endpointId: endpoint.id,
		expectedCount: 1,
	});
	for (const d of settled) await printDeliveryTimeline(baseUrl, d.id);
	printStatusSummary(settled);
};

const routing: Scenario = async (baseUrl) => {
	console.log("routing: fan-out to matching subscriptions only\n");

	const orderSink = await createSink(baseUrl, {
		behavior: "always-200",
		eventTypes: ["order.created"],
	});
	const paymentSink = await createSink(baseUrl, {
		behavior: "always-200",
		eventTypes: ["payment.succeeded"],
	});
	const wildcardSink = await createSink(baseUrl, {
		behavior: "always-200",
		eventTypes: ["*"],
	});

	const { deliveryCount } = await emitEvent(baseUrl, {
		type: "order.created",
		data: { orderId: "ord_1", total: 1010 },
	});
	console.log(`  fanned out to ${deliveryCount} delivery(ies)`);

	// The sinks are freshly created, so scope to each: order + wildcard should each
	// get exactly one Delivery; payment.succeeded should get none.
	const settledOrder = await waitForSettled(baseUrl, {
		endpointId: orderSink.endpoint.id,
		expectedCount: 1,
	});
	const settledWildcard = await waitForSettled(baseUrl, {
		endpointId: wildcardSink.endpoint.id,
		expectedCount: 1,
	});
	const paymentDeliveries = await deliveriesFor(
		baseUrl,
		paymentSink.endpoint.id,
	);

	const mark = (n: number) => (n > 0 ? "received" : "skipped");
	console.log(`  order.created  endpoint: ${mark(settledOrder.length)}`);
	console.log(`  payment.succ.  endpoint: ${mark(paymentDeliveries.length)}`);
	console.log(`  wildcard       endpoint: ${mark(settledWildcard.length)}`);

	const settled = [...settledOrder, ...settledWildcard];
	for (const d of settled) await printDeliveryTimeline(baseUrl, d.id);
	printStatusSummary(settled);
};

export const scenarios: Record<string, Scenario> = {
	"happy-path": happyPath,
	"retry-recovery": retryRecovery,
	"permanent-failure": permanentFailure,
	"gone-disables": goneDisables,
	"delete-cancels": deleteCancels,
	"signature-verified": signatureVerified,
	routing,
};

export const scenarioNames = Object.keys(scenarios);

export { printDeliveryTimeline, printStatusSummary };
