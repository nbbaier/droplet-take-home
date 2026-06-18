import { config } from "./config";

/** `--url <value>` from argv, else the configured base URL. */
export function resolveBaseUrl(argv: string[]): string {
	const i = argv.indexOf("--url");
	if (i !== -1 && argv[i + 1]) return argv[i + 1] as string;
	return config.publicBaseUrl;
}

export type LogFields = Record<string, unknown>;

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
export function log(event: string, fields: LogFields = {}): void {
	if (config.logLevel === "silent") return;
	const line = { ts: new Date().toISOString(), event, ...fields };
	console.log(JSON.stringify(line));
}
