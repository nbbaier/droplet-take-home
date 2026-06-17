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

export const config = {
	/** Where the libsql database file lives. */
	databaseUrl: process.env.DATABASE_URL ?? "file:./webhooks.db",

	/** HTTP server port for the daemon (API + sinks + status). */
	port: num("PORT", 3000),

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

	/** Exponential backoff: min(cap, base * 2^attempt) + jitter. */
	backoffBaseMs: num("BACKOFF_BASE_MS", 1_000),
	backoffCapMs: num("BACKOFF_CAP_MS", 60 * 60 * 1_000),
} as const;

export type Config = typeof config;
