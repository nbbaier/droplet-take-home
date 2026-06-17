/**
 * Event persistence. The system owns id + created_at; the caller supplies only
 * type + data (validated upstream by ingestSchema).
 */

import { db } from "../db/client";
import { newId } from "../ids";
import type { Event } from "../types";
import type { IngestInput } from "../validation";

export async function createEvent(input: IngestInput): Promise<Event> {
	const event: Event = {
		id: newId("evt"),
		type: input.type,
		data: input.data,
		createdAt: new Date().toISOString(),
	};

	await db.execute({
		sql: `INSERT INTO events (id, type, data, created_at) VALUES (?, ?, ?, ?)`,
		args: [event.id, event.type, JSON.stringify(event.data), event.createdAt],
	});

	return event;
}

export async function getEvent(id: string): Promise<Event | null> {
	const result = await db.execute({
		sql: `SELECT * FROM events WHERE id = ?`,
		args: [id],
	});
	const row = result.rows[0];
	if (!row) return null;
	return {
		id: row.id as string,
		type: row.type as Event["type"],
		data: JSON.parse(row.data as string),
		createdAt: row.created_at as string,
	};
}
