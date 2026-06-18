/**
 * Harness entry point.
 *
 *   bun run harness [--url <baseUrl>]            → interactive menu; pick one.
 *   bun run harness <name> [--url <baseUrl>]     → run that scenario once and exit.
 *
 * A THIN CLIENT of the running daemon (ADR 0002): it drives scenarios over HTTP
 * against `bun run dev` (or `bun run demo` for snappy retries) so their data
 * PERSISTS to webhooks.db and shows up in `webhooks status`. (Tests, by contrast,
 * use an isolated temp daemon via src/testing/bootstrap.ts.)
 *
 * Start the daemon first:
 *   bun run dev          # or: bun run demo   (BACKOFF_BASE_MS=200, snappy)
 */

import { config } from "../config";
import { type Scenario, scenarioNames, scenarios } from "./scenarios";

/** `--url <value>` from argv, else the configured base URL. */
function resolveBaseUrl(argv: string[]): string {
	const i = argv.indexOf("--url");
	if (i !== -1 && argv[i + 1]) return argv[i + 1] as string;
	return config.publicBaseUrl;
}

/** Positional args (everything that isn't `--url <value>`). */
function positionals(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--url") {
			i++; // skip the value
			continue;
		}
		out.push(argv[i] as string);
	}
	return out;
}

/** Fail early with a helpful message if the daemon isn't up. */
async function assertDaemonReachable(baseUrl: string): Promise<void> {
	try {
		const res = await fetch(`${baseUrl}/`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Cannot reach the daemon at ${baseUrl} (${reason}).\n` +
				`Start it in another terminal first:\n` +
				`  bun run dev        # or: bun run demo   (snappy retries for a live demo)\n` +
				`then re-run the harness (or pass --url <baseUrl>).`,
		);
	}
}

async function runScenario(
	name: string,
	scenario: Scenario,
	baseUrl: string,
): Promise<void> {
	console.log(`\n▶ scenario: ${name}  (daemon @ ${baseUrl})\n`);
	try {
		await scenario(baseUrl);
		console.log(`\n✓ ${name} complete  —  run \`webhooks status\` to see the metrics\n`);
	} catch (err) {
		console.error(
			`\n✗ ${name} failed: ${err instanceof Error ? err.message : err}\n`,
		);
		process.exitCode = 1;
	}
}

/** No-arg interactive menu: list scenarios, read a choice from stdin, run it. */
async function menu(baseUrl: string): Promise<void> {
	console.log("Scenarios:\n");
	scenarioNames.forEach((name, i) => {
		console.log(`  ${i + 1}. ${name}`);
	});
	process.stdout.write("\nPick a scenario (number or name): ");

	for await (const line of console) {
		const choice = line.trim();
		if (!choice) {
			process.stdout.write("Pick a scenario (number or name): ");
			continue;
		}
		const byIndex = scenarioNames[Number(choice) - 1];
		const name = byIndex ?? (scenarios[choice] ? choice : undefined);
		if (!name) {
			console.log(`Unknown scenario: ${choice}`);
			process.stdout.write("Pick a scenario (number or name): ");
			continue;
		}
		await runScenario(name, scenarios[name] as Scenario, baseUrl);
		return;
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const baseUrl = resolveBaseUrl(argv);
	const name = positionals(argv)[0];

	await assertDaemonReachable(baseUrl);

	if (!name) {
		await menu(baseUrl);
		return;
	}

	const scenario = scenarios[name];
	if (!scenario) {
		console.error(`Unknown scenario: ${name}`);
		console.error(`Available: ${scenarioNames.join(", ")}`);
		process.exitCode = 1;
		return;
	}

	await runScenario(name, scenario, baseUrl);
}

main().catch((err) => {
	// Print the (helpful) message without a stack trace — e.g. "daemon not reachable".
	console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
