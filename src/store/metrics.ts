/**
 * Metrics aggregations for `GET /status`, computed ON-READ from the tables with
 * GROUP BY / filters — there is deliberately NO parallel counter system to drift
 * out of sync (PLAN step 5). Mirrors the other store modules' style.
 *
 * Two tiers:
 *  - Simple aggregations (deliveryStatusCounts, endpointStateCounts,
 *    inBackoffCount, eventCount) — implemented.
 *  - Windowed / statistical metrics (recentThroughput, successRate,
 *    owns the real decisions (window bounds, p95 with small N). Each returns a
 *    typed placeholder so getStatusSnapshot returns a complete 200.
 */

import { db } from "../db/client";
import type { DeliveryStatus, StatusSnapshot } from "../types";

/** Default rolling window for the windowed metrics (5 minutes). */
const DEFAULT_WINDOW_MS = 5 * 60 * 1_000;

/** Counts of Deliveries by status, plus total. Missing statuses come back as 0. */
async function deliveryStatusCounts(): Promise<
	StatusSnapshot["deliveries"]
> {
	const result = await db.execute(
		`SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status`,
	);
	const counts: StatusSnapshot["deliveries"] = {
		pending: 0,
		processing: 0,
		delivered: 0,
		failed: 0,
		canceled: 0,
		total: 0,
	};
	for (const row of result.rows) {
		const status = row.status as DeliveryStatus;
		const n = Number(row.n);
		counts[status] = n;
		counts.total += n;
	}
	return counts;
}

/** Endpoint counts by lifecycle state. `deleted` (deleted_at set) is counted separately. */
async function endpointStateCounts(): Promise<
	StatusSnapshot["endpoints"]
> {
	const result = await db.execute(
		`SELECT
			SUM(CASE WHEN deleted_at IS NULL AND state = 'active' THEN 1 ELSE 0 END) AS active,
			SUM(CASE WHEN deleted_at IS NULL AND state = 'disabled' THEN 1 ELSE 0 END) AS disabled,
			SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
			COUNT(*) AS total
		FROM endpoints`,
	);
	const row = result.rows[0];
	return {
		active: Number(row?.active ?? 0),
		disabled: Number(row?.disabled ?? 0),
		deleted: Number(row?.deleted ?? 0),
		total: Number(row?.total ?? 0),
	};
}

/** `pending` Deliveries whose next_attempt_at is still in the future (waiting out backoff). */
async function inBackoffCount(): Promise<number> {
	const now = new Date().toISOString();
	const result = await db.execute({
		sql: `SELECT COUNT(*) AS n FROM deliveries
			WHERE status = 'pending' AND next_attempt_at > ?`,
		args: [now],
	});
	return Number(result.rows[0]?.n ?? 0);
}

/** Total Events ingested. */
async function eventCount(): Promise<number> {
	const result = await db.execute(`SELECT COUNT(*) AS n FROM events`);
	return Number(result.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Windowed / statistical metrics — STUBBED for the human.
// Each returns a typed placeholder so GET /status stays 200. Implement the math
// described in each TODO; do NOT introduce a counter table (compute on-read).
// ---------------------------------------------------------------------------

/**
 * Deliveries reaching a terminal state within `windowMs`.
 */
async function recentThroughput(
	windowMs: number = DEFAULT_WINDOW_MS,
): Promise<number> {
	const window = new Date(Date.now() - windowMs).toISOString();
	const result = await db.execute({
		sql: `SELECT COUNT(*) AS n FROM deliveries
			WHERE status IN ('delivered','failed','canceled') AND updated_at >= ?`,
		args: [window],
	});
	return Number(result.rows[0]?.n ?? 0);
}

/**
 * Success rate over the window: delivered ÷ (delivered + failed).
 */
async function successRate(
	windowMs = DEFAULT_WINDOW_MS,
): Promise<number | null> {
	const window = new Date(Date.now() - windowMs).toISOString();
	const result = await db.execute({
		sql: `SELECT
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
       FROM deliveries
       WHERE status IN ('delivered','failed') AND updated_at >= ?`,
		args: [window],
	});
	const delivered = Number(result.rows[0]?.delivered ?? 0);
	const failed = Number(result.rows[0]?.failed ?? 0);
	if (delivered + failed === 0) return null;
	return delivered / (delivered + failed);
}

/**
 * Assemble the full StatusSnapshot from the simple aggregations plus the stubbed
 * windowed metrics. Always returns a complete shape so the endpoint is 200/demoable
 * even while the windowed parts are placeholders.
 */
export async function getStatusSnapshot(
	windowMs: number = DEFAULT_WINDOW_MS,
): Promise<StatusSnapshot> {
	const [deliveries, endpoints, inBackoff, events] = await Promise.all([
		deliveryStatusCounts(),
		endpointStateCounts(),
		inBackoffCount(),
		eventCount(),
	]);

	const [throughput, successRateValue] = await Promise.all([
		recentThroughput(windowMs),
		successRate(windowMs),
	]);

	return {
		generatedAt: new Date().toISOString(),
		windowMs,
		deliveries,
		endpoints,
		inBackoff,
		events,
		windowed: {
			throughput,
			successRate: successRateValue,
		},
	};
}
