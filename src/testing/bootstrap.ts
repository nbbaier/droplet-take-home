/**
 * Isolated daemon bootstrap for tests and the harness.
 *
 * `src/config.ts` reads DATABASE_URL/PORT/timing knobs from env *at import time*
 * into a frozen object, and `src/db/client.ts` opens the libsql client at import
 * time. So an isolated instance MUST set env BEFORE those modules are imported.
 * That's why this file dynamic-imports server/worker/migrate (and never statically
 * imports from ../config or ../server): a static import anywhere up the chain would
 * lock config in with the ambient env before we can override it.
 *
 * Each call uses a unique throwaway DB file (so parallel test files don't collide)
 * and demo-fast timing. The returned `stop()` halts the worker + server and deletes
 * the temp DB; ALWAYS call it (afterAll/finally) or the poll loop keeps the process
 * alive and `bun test` hangs.
 */

export interface TestDaemon {
	/** Base URL of the isolated daemon, e.g. http://localhost:53187 */
	baseUrl: string;
	/** Stop the worker + server and delete the temp DB. Idempotent-ish; call once. */
	stop(): Promise<void>;
}

let counter = 0;

/**
 * Start an isolated daemon (API + worker) on an ephemeral port against a throwaway
 * DB, with demo-fast config. Returns `{ baseUrl, stop }`.
 */
export async function startTestDaemon(): Promise<TestDaemon> {
	// Unique per bootstrap so parallel test files / repeated harness runs don't
	// share a DB file. pid + counter is enough; Date.now()/Math.random() avoided
	// to keep this deterministic-friendly.
	counter += 1;
	const dbPath = `./.tmp-harness-${process.pid}-${counter}.db`;

	// Pick a free ephemeral port up front by binding a throwaway server on port 0,
	// reading the assigned port, then releasing it. We need the real port BEFORE
	// importing config, because config freezes `publicBaseUrl` (= the URL the
	// auto-registered Sink Endpoints point back at) from PORT at import time. If we
	// served on port 0 and left PORT="0", deliveries would be POSTed to
	// http://localhost:0 and every Delivery would fail. Small reuse race, fine for tests.
	const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
	const port = probe.port;
	probe.stop(true);

	// 1. Set env BEFORE importing anything that reads config.
	process.env.DATABASE_URL = `file:${dbPath}`;
	process.env.PORT = String(port);
	process.env.PUBLIC_BASE_URL = `http://localhost:${port}`;
	process.env.BACKOFF_BASE_MS = "10"; // demo-fast backoff
	process.env.BACKOFF_CAP_MS = "200";
	process.env.POLL_INTERVAL_MS = "25";
	process.env.VISIBILITY_TIMEOUT_MS = "1000";
	process.env.SINK_SLOW_DELAY_MS = "300"; // 'slow' sink stalls past the timeout
	process.env.REQUEST_TIMEOUT_MS = "100"; // so the 'slow' sink trips a timeout

	// 2. Dynamic-import the modules that snapshot config at import time. Importing
	//    fresh per-call isn't needed (the module graph is process-wide), but env is
	//    set before first import, which is what matters.
	const { app } = await import("../server");
	const { startWorker, stopWorker } = await import("../worker");
	const { migrate } = await import("../db/migrate");

	await migrate();

	const server = Bun.serve({ port, fetch: app.fetch });
	startWorker();

	return {
		baseUrl: `http://localhost:${server.port}`,
		async stop() {
			stopWorker();
			server.stop(true);
			// Remove the temp DB (+ libsql sidecar files) best-effort.
			for (const suffix of ["", "-wal", "-shm"]) {
				await Bun.file(`${dbPath}${suffix}`)
					.unlink()
					.catch(() => {});
			}
		},
	};
}
