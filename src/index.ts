/**
 * Daemon entrypoint: migrate the DB, start the worker, serve the API. One process
 * runs everything (API + sinks + status + worker) — see ADR 0001 / 0002.
 *
 */

import { config } from "./config";
import { migrate } from "./db/migrate";
import { app } from "./server";
import { startWorker, stopWorker } from "./worker";

await migrate();
startWorker();

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(JSON.stringify({ log: "server.started", port: server.port }));

function shutdown() {
	stopWorker();
	server.stop();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
