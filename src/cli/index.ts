#!/usr/bin/env bun
/**
 * `webhooks` CLI — a THIN client over the daemon's HTTP API. It never touches the
 * store/DB directly (ADR 0002): the daemon owns the database; the CLI just calls
 * its endpoints. Right now it implements one command: `status`.
 *
 * Usage:
 *   bun run src/cli/index.ts status [--url http://localhost:3000]
 *
 * Base URL resolution: --url flag > config.publicBaseUrl (PORT/PUBLIC_BASE_URL).
 */

import { config } from "../config";
import type { StatusSnapshot } from "../types";

/** Pull `--url <value>` out of argv; fall back to the configured base URL. */
function resolveBaseUrl(args: string[]): string {
	const i = args.indexOf("--url");
	if (i !== -1 && args[i + 1]) return args[i + 1] as string;
	return config.publicBaseUrl;
}

async function fetchStatus(baseUrl: string): Promise<StatusSnapshot> {
	const res = await fetch(`${baseUrl}/status`);

	if (!res.ok) {
		throw new Error(`GET ${baseUrl}/status → HTTP ${res.status}`);
	}
	return (await res.json()) as StatusSnapshot;
}

/**
 * Basic, readable dump of the snapshot. Intentionally plain.
 *
 * TODO (yours): nicer formatting — aligned columns / sections / color, a compact
 * one-line summary, and a `--watch` live view (PLAN stretch goal). The CLI is
 * where the observability UX polish lives now that there's no dashboard (ADR 0002),
 * so make this tasteful rather than a raw dump.
 */
function renderStatus(s: StatusSnapshot): string {
	const lines: string[] = [];
	lines.push(`webhook-delivery status  (${s.generatedAt})`);
	lines.push("");
	lines.push("Deliveries:");
	lines.push(`  pending    ${s.deliveries.pending}`);
	lines.push(`  processing ${s.deliveries.processing}`);
	lines.push(`  delivered  ${s.deliveries.delivered}`);
	lines.push(`  failed     ${s.deliveries.failed}`);
	lines.push(`  canceled   ${s.deliveries.canceled}`);
	lines.push(`  total      ${s.deliveries.total}`);
	lines.push("");
	lines.push("Endpoints:");
	lines.push(`  active   ${s.endpoints.active}`);
	lines.push(`  disabled ${s.endpoints.disabled}`);
	lines.push(`  deleted  ${s.endpoints.deleted}`);
	lines.push(`  total    ${s.endpoints.total}`);
	lines.push("");
	lines.push(`In backoff: ${s.inBackoff}`);
	lines.push(`Events:     ${s.events}`);
	lines.push("");
	lines.push(
		`Windowed (last ${Math.round(s.windowMs / 1000)}s) [partial — TODO]:`,
	);
	lines.push(`  throughput         ${s.windowed.throughput}`);
	lines.push(`  success rate       ${s.windowed.successRate ?? "n/a"}`);
	return lines.join("\n");
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);

	switch (command) {
		case "status": {
			const baseUrl = resolveBaseUrl(rest);
			const snapshot = await fetchStatus(baseUrl);
			console.log(renderStatus(snapshot));
			break;
		}
		default:
			console.error(`Unknown command: ${command ?? "(none)"}`);
			console.error("Usage: webhooks status [--url <baseUrl>]");
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(String(err));
	process.exit(1);
});
