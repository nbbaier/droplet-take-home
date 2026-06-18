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
 * `happy-path` is fully asserted as the reference. Remaining scenarios follow the
 * same pattern: share setup with scenarios.ts, assert on terminal delivery state.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	createSink,
	deliveriesFor,
	emitEvent,
	getDeliveryWithAttempts,
	listDeliveries,
	listEndpoints,
	waitForSettled,
} from "../src/harness/client";
import type { StatusSnapshot } from "../src/types";
import { startTestDaemon, type TestDaemon } from "./bootstrap";

const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 5);

let daemon: TestDaemon;

async function statusSnapshot(): Promise<StatusSnapshot> {
	const res = await fetch(`${daemon.baseUrl}/status`);
	expect(res.status).toBe(200);
	return (await res.json()) as StatusSnapshot;
}

beforeAll(async () => {
	daemon = await startTestDaemon();
});

afterAll(async () => {
	await daemon.stop();
});

describe("happy-path", () => {
	test("healthy endpoint is delivered on the first attempt", async () => {
		const { endpoint } = await createSink(daemon.baseUrl, {
			behavior: "always-200",
		});

		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_1", total: 42 },
		});

		await waitForSettled(daemon.baseUrl, {
			endpointId: endpoint.id,
			expectedCount: 1,
		});

		const settled = await deliveriesFor(daemon.baseUrl, endpoint.id);
		expect(settled).toHaveLength(1);

		const delivery = settled[0];
		if (!delivery) throw new Error("[happy-path] Delivery not found");

		expect(delivery.status).toBe("delivered");
		expect(delivery.attemptCount).toBe(1);

		const detail = await getDeliveryWithAttempts(daemon.baseUrl, delivery.id);
		expect(detail.attempts).toHaveLength(1);
		const attempt = detail.attempts[0];
		if (!attempt) throw new Error("[happy-path] Attempt not found");
		expect(attempt.statusCode).toBeGreaterThanOrEqual(200);
		expect(attempt.statusCode).toBeLessThan(300);
		expect(attempt.error).toBeNull();
	});
});

describe("retry-recovery", () => {
	test("recovers to delivered after transient 500s", async () => {
		const { endpoint } = await createSink(daemon.baseUrl, {
			behavior: "fail-then-recover",
		});

		await emitEvent(daemon.baseUrl, {
			type: "payment.succeeded",
			data: { paymentId: "pay_1", amount: 42 },
		});

		await waitForSettled(daemon.baseUrl, {
			endpointId: endpoint.id,
			expectedCount: 1,
		});

		const settled = await deliveriesFor(daemon.baseUrl, endpoint.id);
		expect(settled).toHaveLength(1);

		const delivery = settled[0];
		if (!delivery) throw new Error("[retry-recovery] Delivery not found");

		expect(delivery.status).toBe("delivered");
		expect(delivery.attemptCount).toBe(4);

		const detail = await getDeliveryWithAttempts(daemon.baseUrl, delivery.id);
		expect(detail.attempts).toHaveLength(4);
		expect(detail.attempts[0]?.statusCode).toBe(500);
		expect(detail.attempts[1]?.statusCode).toBe(500);
		expect(detail.attempts[2]?.statusCode).toBe(500);

		const lastAttempt = detail.attempts[3];
		if (!lastAttempt) throw new Error("[retry-recovery] Attempt not found");

		expect(lastAttempt.statusCode).toBeGreaterThanOrEqual(200);
		expect(lastAttempt.statusCode).toBeLessThan(300);
		expect(lastAttempt.error).toBeNull();
	});
});

describe("permanent-failure", () => {
	test("exhausts retries and ends failed", async () => {
		const { endpoint } = await createSink(daemon.baseUrl, {
			behavior: "always-500",
		});

		await emitEvent(daemon.baseUrl, {
			type: "payment.failed",
			data: { paymentId: "pay_1", amount: 42 },
		});

		await waitForSettled(daemon.baseUrl, {
			endpointId: endpoint.id,
			expectedCount: 1,
		});

		const settled = await deliveriesFor(daemon.baseUrl, endpoint.id);
		expect(settled).toHaveLength(1);

		const delivery = settled[0];
		if (!delivery) throw new Error("[permanent-failure] Delivery not found");

		expect(delivery.status).toBe("failed");
		expect(delivery.attemptCount).toBe(maxAttempts);

		const detail = await getDeliveryWithAttempts(daemon.baseUrl, delivery.id);
		expect(detail.attempts).toHaveLength(maxAttempts);
		for (const attempt of detail.attempts) {
			expect(attempt.statusCode).toBe(500);
		}
	});
});

describe("gone-disables", () => {
	test("410 fails the delivery and disables the endpoint", async () => {
		const { endpoint } = await createSink(daemon.baseUrl, {
			behavior: "410-gone",
		});

		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_gone", total: 99 },
		});

		await waitForSettled(daemon.baseUrl, {
			endpointId: endpoint.id,
			expectedCount: 1,
		});

		const settled = await deliveriesFor(daemon.baseUrl, endpoint.id);
		expect(settled).toHaveLength(1);

		const delivery = settled[0];
		if (!delivery) throw new Error("[gone-disables] Delivery not found");

		expect(delivery.status).toBe("failed");
		expect(delivery.attemptCount).toBe(1);

		const detail = await getDeliveryWithAttempts(daemon.baseUrl, delivery.id);
		expect(detail.attempts).toHaveLength(1);
		expect(detail.attempts[0]?.statusCode).toBe(410);

		const endpoints = await listEndpoints(daemon.baseUrl);
		const ep = endpoints.find((e) => e.id === endpoint.id);
		expect(ep?.state).toBe("disabled");

		const beforeSecond = (await deliveriesFor(daemon.baseUrl, endpoint.id))
			.length;
		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_gone_2", total: 100 },
		});
		const afterSecond = (await deliveriesFor(daemon.baseUrl, endpoint.id))
			.length;
		expect(afterSecond).toBe(beforeSecond);
	});
});

describe("delete-cancels", () => {
	test("deleting an endpoint cancels its in-flight deliveries", async () => {
		const { endpoint } = await createSink(daemon.baseUrl, {
			behavior: "slow",
		});

		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_delete", total: 100 },
		});

		const deleteRes = await fetch(
			`${daemon.baseUrl}/endpoints/${endpoint.id}`,
			{ method: "DELETE" },
		);
		expect(deleteRes.status).toBe(204);

		const settled = await waitForSettled(daemon.baseUrl, {
			endpointId: endpoint.id,
			expectedCount: 1,
		});
		expect(settled).toHaveLength(1);

		const delivery = settled[0];
		if (!delivery) throw new Error("[delete-cancels] Delivery not found");

		expect(delivery.status).toBe("canceled");
	});
});

describe("signature-verified", () => {
	test("a valid signature is accepted", async () => {
		const { endpoint } = await createSink(daemon.baseUrl, {
			behavior: "verify-signature",
		});

		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_sig", total: 55 },
		});

		await waitForSettled(daemon.baseUrl, {
			endpointId: endpoint.id,
			expectedCount: 1,
		});

		const settled = await deliveriesFor(daemon.baseUrl, endpoint.id);
		expect(settled).toHaveLength(1);

		const delivery = settled[0];
		if (!delivery) throw new Error("[signature-verified] Delivery not found");

		expect(delivery.status).toBe("delivered");
		expect(delivery.attemptCount).toBe(1);

		const detail = await getDeliveryWithAttempts(daemon.baseUrl, delivery.id);
		expect(detail.attempts).toHaveLength(1);
		const attempt = detail.attempts[0];
		if (!attempt) throw new Error("[signature-verified] Attempt not found");

		expect(attempt.statusCode).toBeGreaterThanOrEqual(200);
		expect(attempt.statusCode).toBeLessThan(300);
		expect(attempt.error).toBeNull();
	});
});

describe("routing", () => {
	test("an event fans out only to matching subscriptions", async () => {
		const orderSink = await createSink(daemon.baseUrl, {
			behavior: "always-200",
			eventTypes: ["order.created"],
		});
		const paymentSink = await createSink(daemon.baseUrl, {
			behavior: "always-200",
			eventTypes: ["payment.succeeded"],
		});
		const wildcardSink = await createSink(daemon.baseUrl, {
			behavior: "always-200",
			eventTypes: ["*"],
		});

		const beforeOrder = (
			await deliveriesFor(daemon.baseUrl, orderSink.endpoint.id)
		).length;
		const beforePayment = (
			await deliveriesFor(daemon.baseUrl, paymentSink.endpoint.id)
		).length;
		const beforeWildcard = (
			await deliveriesFor(daemon.baseUrl, wildcardSink.endpoint.id)
		).length;

		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_1", total: 1010 },
		});

		await waitForSettled(daemon.baseUrl, {
			endpointId: orderSink.endpoint.id,
			expectedCount: beforeOrder + 1,
		});
		await waitForSettled(daemon.baseUrl, {
			endpointId: wildcardSink.endpoint.id,
			expectedCount: beforeWildcard + 1,
		});

		const orderDeliveries = await deliveriesFor(
			daemon.baseUrl,
			orderSink.endpoint.id,
		);
		const paymentDeliveries = await deliveriesFor(
			daemon.baseUrl,
			paymentSink.endpoint.id,
		);
		const wildcardDeliveries = await deliveriesFor(
			daemon.baseUrl,
			wildcardSink.endpoint.id,
		);

		expect(orderDeliveries.length).toBe(beforeOrder + 1);
		expect(paymentDeliveries.length).toBe(beforePayment);
		expect(wildcardDeliveries.length).toBe(beforeWildcard + 1);
	});
});

describe("status", () => {
	test("GET /status returns 200 with a complete snapshot shape", async () => {
		// Drive a delivery through so the simple counts are non-trivial.
		const { endpoint } = await createSink(daemon.baseUrl, {
			behavior: "always-200",
		});
		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_status" },
		});
		await waitForSettled(daemon.baseUrl, {
			endpointId: endpoint.id,
			expectedCount: 1,
		});

		const res = await fetch(`${daemon.baseUrl}/status`);
		expect(res.status).toBe(200);
		const snapshot = (await res.json()) as StatusSnapshot;

		// Simple aggregations (implemented) — sane, non-negative, internally consistent.
		expect(typeof snapshot.generatedAt).toBe("string");
		const d = snapshot.deliveries;
		expect(d.delivered).toBeGreaterThanOrEqual(1);
		expect(d.total).toBe(
			d.pending + d.processing + d.delivered + d.failed + d.canceled,
		);
		expect(snapshot.endpoints.total).toBeGreaterThanOrEqual(1);
		expect(snapshot.events).toBeGreaterThanOrEqual(1);
		expect(snapshot.inBackoff).toBeGreaterThanOrEqual(0);

		// Windowed metrics exist in the shape even while stubbed.
		expect(snapshot.windowed).toBeDefined();
	});

	test("windowed throughput counts terminal deliveries in the window", async () => {
		const deliveredSink = await createSink(daemon.baseUrl, {
			behavior: "always-200",
		});
		const failedSink = await createSink(daemon.baseUrl, {
			behavior: "always-500",
		});
		const canceledSink = await createSink(daemon.baseUrl, {
			behavior: "slow",
		});

		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_throughput_delivered" },
		});
		await waitForSettled(daemon.baseUrl, {
			endpointId: deliveredSink.endpoint.id,
			expectedCount: 1,
		});
		await waitForSettled(daemon.baseUrl, {
			endpointId: failedSink.endpoint.id,
			expectedCount: 1,
		});

		await emitEvent(daemon.baseUrl, {
			type: "order.created",
			data: { orderId: "ord_throughput_canceled" },
		});
		const deleteRes = await fetch(
			`${daemon.baseUrl}/endpoints/${canceledSink.endpoint.id}`,
			{ method: "DELETE" },
		);
		expect(deleteRes.status).toBe(204);
		await waitForSettled(daemon.baseUrl, {
			endpointId: canceledSink.endpoint.id,
			expectedCount: 2,
		});

		const snapshot = await statusSnapshot();
		const windowStart = Date.now() - snapshot.windowMs;
		const terminalDeliveries = (await listDeliveries(daemon.baseUrl)).filter(
			(delivery) =>
				["delivered", "failed", "canceled"].includes(delivery.status) &&
				Date.parse(delivery.updatedAt) >= windowStart,
		);

		expect(snapshot.windowed.throughput).toBe(terminalDeliveries.length);
		expect(snapshot.windowed.throughput).toBeGreaterThanOrEqual(3);
	});

	test("successRate = delivered ÷ (delivered + failed) over the window", async () => {
		const deliveredSink = await createSink(daemon.baseUrl, {
			behavior: "always-200",
		});
		const failedSink = await createSink(daemon.baseUrl, {
			behavior: "always-500",
		});

		await emitEvent(daemon.baseUrl, {
			type: "payment.succeeded",
			data: { paymentId: "pay_rate_delivered" },
		});
		await waitForSettled(daemon.baseUrl, {
			endpointId: deliveredSink.endpoint.id,
			expectedCount: 1,
		});
		await waitForSettled(daemon.baseUrl, {
			endpointId: failedSink.endpoint.id,
			expectedCount: 1,
		});

		const snapshot = await statusSnapshot();
		const windowStart = Date.now() - snapshot.windowMs;
		const deliveries = (await listDeliveries(daemon.baseUrl)).filter(
			(delivery) => Date.parse(delivery.updatedAt) >= windowStart,
		);
		const delivered = deliveries.filter(
			(delivery) => delivery.status === "delivered",
		).length;
		const failed = deliveries.filter(
			(delivery) => delivery.status === "failed",
		).length;
		const expected =
			delivered + failed === 0 ? null : delivered / (delivered + failed);

		expect(snapshot.windowed.successRate).toBe(expected);
		expect(snapshot.windowed.successRate).not.toBeNull();
	});
});
