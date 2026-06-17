/**
 * Applies schema.sql. Idempotent (all statements are CREATE ... IF NOT EXISTS),
 * so it's safe to run on every startup. Called from index.ts before serving.
 */

import { db } from "./client";

export async function migrate(): Promise<void> {
	const schema = await Bun.file(
		new URL("./schema.sql", import.meta.url),
	).text();
	// executeMultiple runs the whole script (multiple statements, incl. PRAGMAs).
	await db.executeMultiple(schema);
}
