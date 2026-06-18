/**
 * Central runtime configuration.
 *
 * Every timing knob lives here so the harness/demo can shrink delays (e.g. set a
 * tiny BACKOFF_BASE_MS) while production-ish defaults stay documented. Values are
 * read from env once at startup; see the README for the table of defaults.
 */

function num(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}
const port = num("PORT", 3000);

/** Logging verbosity: "info" emits JSON-line lifecycle logs; "silent" suppresses. */
function logLevel(): "info" | "silent" {
	return process.env.LOG_LEVEL === "silent" ? "silent" : "info";
}

export const config = {
	/** Where the libsql database file lives. */
	databaseUrl: process.env.DATABASE_URL ?? "file:./webhooks.db",

	/** HTTP server port for the daemon (API + sinks + status). */
	port,
	/** Per-Attempt outbound HTTP timeout. */
	requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 10_000),

	/** A `processing` row older than this is presumed crashed and reclaimed. */
	visibilityTimeoutMs: num("VISIBILITY_TIMEOUT_MS", 30_000),

	/** Max Attempts in flight at once across the worker. */
	concurrency: num("CONCURRENCY", 10),

	/** How often the worker wakes to claim due Deliveries. */
	pollIntervalMs: num("POLL_INTERVAL_MS", 250),

	/** How many due Deliveries a single tick claims. */
	claimBatchSize: num("CLAIM_BATCH_SIZE", 20),

	/** Attempts before a Delivery is marked permanently `failed`. */
	maxAttempts: num("MAX_ATTEMPTS", 5),

	/** How many hits before success for the fail-then-recover sink behavior. */
	failThenRecoverThreshold: num("FAIL_THEN_RECOVER_THRESHOLD", 3), // how many hits before success

	/** Exponential backoff: min(cap, base * 2^attempt) + jitter. */
	backoffBaseMs: num("BACKOFF_BASE_MS", 1_000),
	backoffCapMs: num("BACKOFF_CAP_MS", 60 * 60 * 1_000),

	/** Max chars of an endpoint's response body we persist (the rest is dropped). */
	maxResponseBodyChars: num("MAX_RESPONSE_BODY_CHARS", 2_048),

	/**
	 * Base URL the daemon serves on, used to point auto-registered Sink Endpoints
	 * at our own `/_sink/:id` route. Derived from PORT unless overridden.
	 */
	publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,

	/** How long the `slow` Sink behavior stalls before responding. */
	sinkSlowDelayMs: num("SINK_SLOW_DELAY_MS", 15_000),

	/**
	 * Logging verbosity. "info" (default) emits one JSON line per lifecycle event
	 * to stdout; "silent" suppresses all logs (tests/harness set LOG_LEVEL=silent
	 * so `bun test` output isn't flooded). See src/log.ts.
	 */
	logLevel: logLevel(),
} as const;
