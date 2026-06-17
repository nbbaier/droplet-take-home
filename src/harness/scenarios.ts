/**
 * Scenario registry: name -> async (baseUrl) => void. Each scenario drives the
 * daemon over HTTP (via ./client) and PRINTS a human-readable timeline + a small
 * status summary derived from GET /deliveries (NOT a status endpoint — that's
 * PLAN step 5). The matching `bun test` cases ASSERT the same setup; share these
 * helpers, don't fork the logic.
 *
 * `happy-path` is fully worked as the reference template. The rest are stubbed:
 * each throws with a TODO describing exactly what to set up and assert, for the
 * human to fill in. Keep the print/assert split — scenarios print, tests assert.
 */

import {
	createSink,
	emitEvent,
	getDeliveryWithAttempts,
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

// ---------------------------------------------------------------------------
// happy-path — the fully-worked reference scenario.
// ---------------------------------------------------------------------------

/**
 * Healthy endpoint, single event, delivered on the first try.
 *
 * setup:  always-200 sink (auto-registers an Endpoint).
 * emit:   one order.created event.
 * assert (in the test): one Delivery, status `delivered`, attempt_count === 1,
 *         single Attempt with a 2xx status code.
 */
const happyPath: Scenario = async (baseUrl) => {
	console.log("happy-path: healthy endpoint, delivered on first try\n");

	// Capture the endpoint so we scope waiting/printing to THIS scenario's
	// deliveries — the daemon's DB is shared across runs/tests. Copy this shape.
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

// ---------------------------------------------------------------------------
// Stubbed scenarios — TODO (yours). Each describes setup + what to assert.
// Implement by copying the happy-path shape; keep print here, assert in the test.
// Capture the endpoint id from createSink/registerEndpoint and pass it to
// waitForSettled({ endpointId }) / deliveriesFor(baseUrl, endpointId) so you
// assert on THIS scenario's deliveries — the daemon's DB is shared across tests.
// ---------------------------------------------------------------------------

const retryRecovery: Scenario = async (_baseUrl) => {
	// TODO (yours): retry-recovery.
	// setup:  a FRESH `fail-then-recover` sink (hits are per-sink, NOT per-delivery —
	//         a reused sink may have already burned its failing hits). Emit one event.
	// expect: the worker retries through the 500s and eventually delivers.
	// assert (test): one Delivery ends `delivered` with attempt_count === 4
	//         (config.failThenRecoverThreshold=3 → 3×500 then 200), and the Attempt
	//         timeline shows three 500s followed by a 200.
	// print:  the per-Attempt timeline via printDeliveryTimeline + status summary.
	throw new Error("retry-recovery scenario not implemented");
};

const permanentFailure: Scenario = async (_baseUrl) => {
	// TODO (yours): permanent-failure.
	// setup:  an `always-500` sink. Emit one event.
	// expect: every Attempt 500s; the worker exhausts retries.
	// assert (test): the Delivery ends `failed` with attempt_count === config.maxAttempts
	//         (default 5), and the Attempt timeline is all 500s.
	// print:  the per-Attempt timeline + status summary.
	throw new Error("permanent-failure scenario not implemented");
};

const goneDisables: Scenario = async (_baseUrl) => {
	// TODO (yours): gone-disables.
	// setup:  a `410-gone` sink. Capture its endpoint id from createSink(). Emit one event.
	// expect: 410 is a permanent failure that ALSO disables the Endpoint and cancels
	//         its other queued Deliveries (see worker.ts `gone` case).
	// assert (test): the Delivery ends `failed`; GET /endpoints shows that Endpoint
	//         `state: "disabled"`; a SECOND event of the same type produces NO new
	//         Delivery for it (no fan-out to disabled Endpoints).
	// print:  the timeline + the endpoint's post-state.
	throw new Error("gone-disables scenario not implemented");
};

const deleteCancels: Scenario = async (_baseUrl) => {
	// TODO (yours): delete-cancels — BLOCKED.
	// This scenario needs `DELETE /endpoints/:id` (soft-delete + proactive cancel of
	// queued Deliveries), which does NOT exist yet (PLAN edge-case [~], out of scope
	// for the harness step — do NOT build the route here).
	// Once that route exists:
	// setup:  a `slow` sink (so Deliveries sit in-flight long enough to cancel). Emit
	//         an event, then DELETE the endpoint before delivery completes.
	// assert (test): in-flight Deliveries end `canceled` (NOT `failed`).
	throw new Error(
		"delete-cancels scenario blocked on DELETE /endpoints/:id (not implemented)",
	);
};

const signatureVerified: Scenario = async (_baseUrl) => {
	// TODO (yours): signature-verified.
	// setup:  a `verify-signature` sink. It recomputes HMAC over `${timestamp}.${body}`
	//         with the Endpoint secret and 401s on mismatch (see sinks.ts). Emit one event.
	// expect: the delivered envelope's signature verifies → 200.
	// assert (test): the Delivery ends `delivered`, attempt_count === 1, Attempt is 200.
	// optional: a tampered variant — there's no knob to corrupt the signature from the
	//         client side (signing is server-side), so document this as out of reach via
	//         the HTTP surface, or add a sink behavior in a future step.
	// print:  the timeline + summary.
	throw new Error("signature-verified scenario not implemented");
};

const routing: Scenario = async (_baseUrl) => {
	// TODO (yours): routing.
	// setup:  register endpoints with DISJOINT event_types plus one wildcard ["*"]:
	//         e.g. sink A subscribes ["order.created"], sink B ["payment.succeeded"],
	//         sink C ["*"]. Use createSink({ behavior: "always-200", eventTypes: [...] }).
	// emit:   ONE order.created event.
	// expect: fan-out routes only to matching subscriptions (frozen at fan-out).
	// assert (test): exactly the order.created endpoint (A) and the wildcard (C) get a
	//         Delivery; B gets none. Cross-check by mapping Deliveries' endpoint_id to
	//         the captured sink endpoint ids. deliveryCount from emitEvent should be 2.
	// print:  which endpoints received Deliveries + summary.
	throw new Error("routing scenario not implemented");
};

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

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
