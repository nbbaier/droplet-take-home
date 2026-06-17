/**
 * Attempt persistence — one row per HTTP try, appended (never overwritten) so the
 * full retry timeline of a Delivery is preserved for observability.
 */

import type { Row } from "@libsql/client";
import { db } from "../db/client";
import { newId } from "../ids";
import type { Attempt } from "../types";

export interface RecordAttemptInput {
	deliveryId: string;
	attemptNumber: number;
	statusCode: number | null;
	responseBody: string | null;
	error: string | null;
	durationMs: number;
}

export async function recordAttempt(
	input: RecordAttemptInput,
): Promise<Attempt> {
	const attempt: Attempt = {
		id: newId("att"),
		createdAt: new Date().toISOString(),
		...input,
	};

	await db.execute({
		sql: `INSERT INTO attempts
			(id, delivery_id, attempt_number, status_code, response_body, error, duration_ms, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			attempt.id,
			attempt.deliveryId,
			attempt.attemptNumber,
			attempt.statusCode,
			attempt.responseBody,
			attempt.error,
			attempt.durationMs,
			attempt.createdAt,
		],
	});

	return attempt;
}

function rowToAttempt(row: Row): Attempt {
	return {
		id: row.id as string,
		deliveryId: row.delivery_id as string,
		attemptNumber: Number(row.attempt_number),
		statusCode: row.status_code === null ? null : Number(row.status_code),
		responseBody: (row.response_body as string | null) ?? null,
		error: (row.error as string | null) ?? null,
		durationMs: Number(row.duration_ms),
		createdAt: row.created_at as string,
	};
}

/** The full Attempt timeline for one Delivery, oldest first. */
export async function listAttemptsForDelivery(
	deliveryId: string,
): Promise<Attempt[]> {
	const result = await db.execute({
		sql: `SELECT * FROM attempts WHERE delivery_id = ? ORDER BY attempt_number ASC`,
		args: [deliveryId],
	});
	return result.rows.map(rowToAttempt);
}
