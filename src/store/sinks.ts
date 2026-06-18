/**
 * Sink persistence. Sinks are test infrastructure: an in-process receiver wired
 * to a configurable Behavior, each owning a real Endpoint that points back at our
 * own `POST /_sink/:id` route. Simple CRUD is implemented here; the per-Behavior
 * response logic lives in sinks.ts.
 */

import type { Row } from "@libsql/client";
import { db } from "../db/client";
import { newId } from "../ids";
import type { Sink, SinkBehavior } from "../types";

function rowToSink(row: Row): Sink {
	return {
		id: row.id as string,
		endpointId: row.endpoint_id as string,
		behavior: row.behavior as SinkBehavior,
		hits: Number(row.hits),
		createdAt: row.created_at as string,
	};
}

/**
 * Create a Sink for an already-registered Endpoint. `id` may be supplied so the
 * caller can mint it up front and embed it in the Endpoint's `/_sink/:id` URL
 * (the Endpoint URL and the Sink id are mutually dependent).
 */
export async function createSink(
	endpointId: string,
	behavior: SinkBehavior,
	id: string = newId("sink"),
): Promise<Sink> {
	const sink: Sink = {
		id,
		endpointId,
		behavior,
		hits: 0,
		createdAt: new Date().toISOString(),
	};

	await db.execute({
		sql: `INSERT INTO sinks (id, endpoint_id, behavior, hits, created_at)
			VALUES (?, ?, ?, ?, ?)`,
		args: [sink.id, sink.endpointId, sink.behavior, sink.hits, sink.createdAt],
	});

	return sink;
}

export async function getSink(id: string): Promise<Sink | null> {
	const result = await db.execute({
		sql: `SELECT * FROM sinks WHERE id = ?`,
		args: [id],
	});
	const row = result.rows[0];
	return row ? rowToSink(row) : null;
}

/**
 * Atomically bump the hit counter and return the new total. Stateful behaviors
 * (e.g. fail-then-recover) compare this against a threshold.
 */
export async function incrementHits(id: string): Promise<number> {
	const result = await db.execute({
		sql: `UPDATE sinks SET hits = hits + 1 WHERE id = ? RETURNING hits`,
		args: [id],
	});
	const row = result.rows[0];
	return row ? Number(row.hits) : 0;
}

async function listSinks(): Promise<Sink[]> {
	const result = await db.execute(
		`SELECT * FROM sinks ORDER BY created_at DESC`,
	);
	return result.rows.map(rowToSink);
}
