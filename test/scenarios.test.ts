/**
 * `bun test` suite — 1:1 with the harness scenarios. Tests ASSERT; the harness
 * scenarios (src/harness/scenarios.ts) PRINT. Both share the same HTTP client
 * helpers and the same isolated-daemon bootstrap, so setup never forks.
 *
 * IMPORTANT: do NOT statically import from ../src/config or ../src/server here.
 * The bootstrap sets env (DATABASE_URL/PORT/timing) and THEN dynamic-imports
 * those modules; a static import would lock config in with the ambient env first.
 * Import only the bootstrap + client helpers (client.ts is store/db-free).
 *
 * `happy-path` is fully asserted as the reference. The remaining scenarios are
 * `test.todo` — the suite stays green while the gaps stay visible. Fill each in
 * alongside its scenario in scenarios.ts.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	createSink,
	deliveriesFor,
	emitEvent,
	getDeliveryWithAttempts,
	waitForSettled,
} from "../src/harness/client";
import { startTestDaemon, type TestDaemon } from "../src/testing/bootstrap";

let daemon: TestDaemon;

beforeAll(async () => {
	daemon = await startTestDaemon();
});

afterAll(async () => {
	// MUST stop, or the worker poll loop + server keep the process alive and the
	// test run hangs.
	await daemon.stop();
});

test("happy-path: healthy endpoint is delivered on the first attempt", async () => {
	// Scope to THIS endpoint: the test daemon shares one DB across all tests, so
	// the global delivery list mixes in other tests' rows. Copy this shape.
	const { endpoint } = await createSink(daemon.baseUrl, {
		behavior: "always-200",
	});

	const { deliveryCount } = await emitEvent(daemon.baseUrl, {
		type: "order.created",
		data: { orderId: "ord_1", total: 42 },
	});
	expect(deliveryCount).toBe(1);

	const settled = await waitForSettled(daemon.baseUrl, {
		endpointId: endpoint.id,
		expectedCount: 1,
	});
	expect(settled).toHaveLength(1);

	const delivery = settled[0]!;
	expect(delivery.status).toBe("delivered");
	expect(delivery.attemptCount).toBe(1);

	const detail = await getDeliveryWithAttempts(daemon.baseUrl, delivery.id);
	expect(detail.attempts).toHaveLength(1);
	const attempt = detail.attempts[0]!;
	expect(attempt.statusCode).toBeGreaterThanOrEqual(200);
	expect(attempt.statusCode).toBeLessThan(300);
	expect(attempt.error).toBeNull();
});

// The scenarios below are stubbed in src/harness/scenarios.ts. Each test.todo
// names what to assert once the scenario is implemented (copy the happy-path shape).

// retry-recovery: FRESH fail-then-recover sink → emit → delivery ends `delivered`
// with attempt_count === 4 (3×500 then 200); timeline shows three 500s then a 200.
test.todo("retry-recovery: recovers to delivered after transient 500s", () => {});

// permanent-failure: always-500 sink → emit → delivery ends `failed` after exactly
// config.maxAttempts attempts; every Attempt is a 500.
test.todo("permanent-failure: exhausts retries and ends failed", () => {});

// gone-disables: 410-gone sink → emit → delivery `failed`, Endpoint `disabled`,
// and a second event of the same type produces no new Delivery for it.
test.todo("gone-disables: 410 fails the delivery and disables the endpoint", () => {});

// delete-cancels: BLOCKED on DELETE /endpoints/:id (route not implemented; out of
// scope for this step). Once it exists: slow sink → emit → delete endpoint in-flight
// → in-flight Deliveries end `canceled` (not `failed`).
test.todo("delete-cancels: deleting an endpoint cancels its in-flight deliveries", () => {});

// signature-verified: verify-signature sink → emit → delivery `delivered`,
// attempt_count === 1, Attempt is 200 (the server-signed envelope verifies).
test.todo("signature-verified: a valid signature is accepted", () => {});

// routing: disjoint event_types + one ["*"] → emit one type → only the matching
// endpoint and the wildcard get Deliveries (deliveryCount === 2); the third gets none.
test.todo("routing: an event fans out only to matching subscriptions", () => {});
