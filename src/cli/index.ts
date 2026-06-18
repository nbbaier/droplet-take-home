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

// --- formatting helpers --------------------------------------------------

// Color only when writing to a TTY and NO_COLOR isn't set — so piped/redirected
// output (logs, grep, CI) stays plain. Color is used ONLY in the header/summary
// lines, never inside the aligned columns, so padding math sees raw widths.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
} as const;
function paint(code: string, s: string): string {
	return useColor ? `${code}${s}${ANSI.reset}` : s;
}

/** ISO → "YYYY-MM-DD HH:MM:SS". */
function shortTime(iso: string): string {
	return iso.replace("T", " ").slice(0, 19);
}

/** A "label   value" line, value right-aligned in a fixed column. */
function kv(label: string, value: number, labelWidth: number): string {
	return `  ${label.padEnd(labelWidth)}${String(value).padStart(5)}`;
}

/** Join two columns of pre-formatted (plain, un-colored) lines side by side. */
function sideBySide(left: string[], right: string[], gap = 4): string[] {
	const width = Math.max(...left.map((l) => l.length));
	const rows: string[] = [];
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const l = left[i] ?? "";
		const r = right[i] ?? "";
		rows.push(l.padEnd(width + gap) + r);
	}
	return rows;
}

function renderStatus(s: StatusSnapshot): string {
	const d = s.deliveries;
	const e = s.endpoints;
	const healthy = d.failed === 0 && e.disabled === 0;
	const health = healthy
		? paint(ANSI.green, "healthy")
		: paint(ANSI.yellow, "degraded");
	const rate =
		s.windowed.successRate === null
			? "n/a"
			: `${Math.round(s.windowed.successRate * 100)}%`;

	const out: string[] = [];
	out.push(
		`${paint(ANSI.bold, "webhook-delivery")} ${paint(ANSI.dim, "—")} ${health}` +
			`    ${paint(ANSI.dim, shortTime(s.generatedAt))}`,
	);
	out.push("");

	// Glanceable one-line tallies.
	const dot = (color: string, n: number, label: string) =>
		`${paint(n > 0 ? color : ANSI.dim, "●")} ${n} ${label}`;
	out.push(
		"  " +
			[
				dot(ANSI.green, d.delivered, "delivered"),
				dot(ANSI.dim, d.pending, "pending"),
				dot(ANSI.dim, d.processing, "in-flight"),
				dot(ANSI.red, d.failed, "failed"),
				dot(ANSI.dim, d.canceled, "canceled"),
			].join("   "),
	);
	out.push(
		"  " +
			paint(
				ANSI.dim,
				`success ${rate}  ·  throughput ${s.windowed.throughput} (last ${Math.round(
					s.windowMs / 1000,
				)}s)  ·  in-backoff ${s.inBackoff}  ·  events ${s.events}`,
			),
	);
	out.push("");

	// Detailed breakdown, two aligned columns (plain text).
	const left = [
		"Deliveries",
		kv("delivered", d.delivered, 11),
		kv("pending", d.pending, 11),
		kv("in-flight", d.processing, 11),
		kv("failed", d.failed, 11),
		kv("canceled", d.canceled, 11),
		kv("total", d.total, 11),
	];
	const right = [
		"Endpoints",
		kv("active", e.active, 10),
		kv("disabled", e.disabled, 10),
		kv("deleted", e.deleted, 10),
		kv("total", e.total, 10),
	];
	out.push(...sideBySide(left, right));

	return out.join("\n");
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
