/**
 * Delivery persistence + the queue claim. A Delivery is one Event headed to one
 * Endpoint — the durable unit the worker drains.
 *
 * Simple state transitions are implemented. `claimBatch` — the atomic claim with
 * visibility-timeout reclaim — is left stubbed; it's the ⚠️ bug-prone heart of
 * the queue (see PLAN step 2) and yours to write.
 */

import type { Row } from "@libsql/client";
import { db } from "../db/client";
import { newId } from "../ids";
import type { Delivery, DeliveryStatus } from "../types";

function rowToDelivery(row: Row): Delivery {
	return {
		id: row.id as string,
		eventId: row.event_id as string,
		endpointId: row.endpoint_id as string,
		status: row.status as DeliveryStatus,
		attemptCount: Number(row.attempt_count),
		nextAttemptAt: (row.next_attempt_at as string | null) ?? null,
		claimedAt: (row.claimed_at as string | null) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

/** Create a pending Delivery, due immediately. Called by fan-out. */
export async function createDelivery(eventId: string, endpointId: string): Promise<Delivery> {
	const now = new Date().toISOString();
	const delivery: Delivery = {
		id: newId("dlv"),
		eventId,
		endpointId,
		status: "pending",
		attemptCount: 0,
		nextAttemptAt: now, // due now
		claimedAt: null,
		createdAt: now,
		updatedAt: now,
	};

	await db.execute({
		sql: `INSERT INTO deliveries
			(id, event_id, endpoint_id, status, attempt_count, next_attempt_at, claimed_at, created_at, updated_at)
			VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
		args: [delivery.id, eventId, endpointId, now, now, now],
	});

	return delivery;
}

export async function getDelivery(id: string): Promise<Delivery | null> {
	const result = await db.execute({
		sql: `SELECT * FROM deliveries WHERE id = ?`,
		args: [id],
	});
	const row = result.rows[0];
	return row ? rowToDelivery(row) : null;
}

export async function listDeliveries(): Promise<Delivery[]> {
	const result = await db.execute(`SELECT * FROM deliveries ORDER BY created_at DESC`);
	return result.rows.map(rowToDelivery);
}

/**
 * TODO (yours — PLAN step 2, ⚠️ bug-prone):
 * Atomically claim up to `limit` Deliveries that are due, AND reclaim rows stuck
 * in `processing` past the visibility timeout. Set status='processing' and
 * claimed_at=now on the claimed rows, and return them as Delivery[].
 *
 * Candidate set:
 *   (status='pending'    AND next_attempt_at <= now)
 *   OR (status='processing' AND claimed_at < now - visibilityTimeoutMs)
 *
 * Must be safe against overlapping ticks (single-process, but Bun runs the loop
 * concurrently): use an UPDATE ... WHERE id IN (SELECT ... LIMIT ?) RETURNING,
 * or a transaction, so a row is never handed out twice.
 */
export async function claimBatch(_limit: number): Promise<Delivery[]> {
	throw new Error("claimBatch not implemented");
}

/** Terminal success: an Attempt returned 2xx. */
export async function markDelivered(id: string): Promise<void> {
	const now = new Date().toISOString();
	await db.execute({
		sql: `UPDATE deliveries
			SET status = 'delivered', attempt_count = attempt_count + 1, claimed_at = NULL, updated_at = ?
			WHERE id = ?`,
		args: [now, id],
	});
}

/** Terminal failure: retries exhausted or a permanent error. */
export async function markFailed(id: string): Promise<void> {
	const now = new Date().toISOString();
	await db.execute({
		sql: `UPDATE deliveries
			SET status = 'failed', attempt_count = attempt_count + 1, claimed_at = NULL, updated_at = ?
			WHERE id = ?`,
		args: [now, id],
	});
}

/**
 * Terminal cancel: the target Endpoint was deleted/disabled before delivery.
 * Distinct from `failed` — nothing went wrong with the delivery itself.
 */
export async function cancelDeliveriesForEndpoint(endpointId: string): Promise<void> {
	const now = new Date().toISOString();
	await db.execute({
		sql: `UPDATE deliveries
			SET status = 'canceled', claimed_at = NULL, updated_at = ?
			WHERE endpoint_id = ? AND status IN ('pending', 'processing')`,
		args: [now, endpointId],
	});
}
