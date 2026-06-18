/**
 * Endpoint persistence. Simple CRUD is implemented; routing/fan-out lives in
 * fanout.ts. Endpoints are soft-deleted (deleted_at) and can be `disabled`.
 */

import type { Row } from "@libsql/client";
import { db } from "../db/client";
import { newId } from "../ids";
import type { Endpoint, EndpointState, EventTypeSubscription } from "../types";
import type { RegisterEndpointInput } from "../validation";

function rowToEndpoint(row: Row): Endpoint {
	return {
		id: row.id as string,
		url: row.url as string,
		secret: row.secret as string,
		eventTypes: JSON.parse(row.event_types as string) as EventTypeSubscription,
		state: row.state as EndpointState,
		disabledAt: (row.disabled_at as string | null) ?? null,
		deletedAt: (row.deleted_at as string | null) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

/** A per-Endpoint signing secret, returned to the caller once at creation. */
function generateSecret(): string {
	return `whsec_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function createEndpoint(
	input: RegisterEndpointInput,
): Promise<Endpoint> {
	const now = new Date().toISOString();
	const endpoint: Endpoint = {
		id: newId("ep"),
		url: input.url,
		secret: generateSecret(),
		eventTypes: input.eventTypes,
		state: "active",
		disabledAt: null,
		deletedAt: null,
		createdAt: now,
		updatedAt: now,
	};

	await db.execute({
		sql: `INSERT INTO endpoints
			(id, url, secret, event_types, state, disabled_at, deleted_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
		args: [
			endpoint.id,
			endpoint.url,
			endpoint.secret,
			JSON.stringify(endpoint.eventTypes),
			endpoint.state,
			endpoint.createdAt,
			endpoint.updatedAt,
		],
	});

	return endpoint;
}

export async function getEndpoint(id: string): Promise<Endpoint | null> {
	const result = await db.execute({
		sql: `SELECT * FROM endpoints WHERE id = ?`,
		args: [id],
	});
	const row = result.rows[0];
	return row ? rowToEndpoint(row) : null;
}

/** Active, non-deleted endpoints — the set fan-out considers. */
export async function listActiveEndpoints(): Promise<Endpoint[]> {
	const result = await db.execute(
		`SELECT * FROM endpoints WHERE state = 'active' AND deleted_at IS NULL`,
	);
	return result.rows.map(rowToEndpoint);
}

export async function listEndpoints(): Promise<Endpoint[]> {
	const result = await db.execute(
		`SELECT * FROM endpoints WHERE deleted_at IS NULL ORDER BY created_at DESC`,
	);
	return result.rows.map(rowToEndpoint);
}

/**
 * Operator soft-delete. Sets deleted_at; existing queued Deliveries to this
 * Endpoint must be canceled by the caller (see PLAN edge-case behaviors).
 */
export async function softDeleteEndpoint(id: string): Promise<void> {
	const now = new Date().toISOString();
	await db.execute({
		sql: `UPDATE endpoints SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		args: [now, now, id],
	});
}

/** System-initiated disable (e.g. after a 410 Gone). Reversible. */
export async function disableEndpoint(id: string): Promise<void> {
	const now = new Date().toISOString();
	await db.execute({
		sql: `UPDATE endpoints SET state = 'disabled', disabled_at = ?, updated_at = ? WHERE id = ?`,
		args: [now, now, id],
	});
}
