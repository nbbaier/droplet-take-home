/**
 * Tiny structured logger. Every lifecycle event is one JSON object per line on
 * stdout: `{ ts, event, ...fields }`. Fields are kept flat and snake_case to
 * match the event names so logs are greppable and machine-parseable.
 *
 * Correlate a Delivery's whole life by `delivery_id` (and `event_id`); see the
 * call sites in server.ts / fanout.ts / worker.ts.
 *
 * Silenceable via config.logLevel ("silent") — the test bootstrap sets
 * LOG_LEVEL=silent so `bun test`/harness runs aren't drowned in log lines.
 *
 * Do NOT pass secrets (Endpoint `secret`, computed signatures) as fields.
 */

import { config } from "./config";

export type LogFields = Record<string, unknown>;

/** Emit one JSON line for `event` with optional flat `fields`. No-op when silent. */
export function log(event: string, fields: LogFields = {}): void {
	if (config.logLevel === "silent") return;
	const line = { ts: new Date().toISOString(), event, ...fields };
	console.log(JSON.stringify(line));
}
