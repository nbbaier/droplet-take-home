/**
 * Harness entry point.
 *
 *   bun run harness            → interactive menu listing scenarios; pick one.
 *   bun run harness <name>     → run that scenario once and exit.
 *
 * Self-contained: spins up its OWN isolated daemon (bootstrap) on an ephemeral
 * port with demo-fast config, runs the scenario against it over HTTP, then tears
 * it down. Never touches the DB directly (ADR 0002).
 */

import { startTestDaemon } from "../testing/bootstrap";
import { type Scenario, scenarioNames, scenarios } from "./scenarios";

async function runScenario(name: string, scenario: Scenario): Promise<void> {
	const daemon = await startTestDaemon();
	console.log(`\n▶ scenario: ${name}  (daemon @ ${daemon.baseUrl})\n`);
	try {
		await scenario(daemon.baseUrl);
		console.log(`\n✓ ${name} complete\n`);
	} catch (err) {
		console.error(`\n✗ ${name} failed: ${err instanceof Error ? err.message : err}\n`);
		process.exitCode = 1;
	} finally {
		await daemon.stop();
	}
}

/** No-arg interactive menu: list scenarios, read a choice from stdin, run it. */
async function menu(): Promise<void> {
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
		await runScenario(name, scenarios[name]!);
		return;
	}
}

async function main(): Promise<void> {
	const name = process.argv[2];

	if (!name) {
		await menu();
		return;
	}

	const scenario = scenarios[name];
	if (!scenario) {
		console.error(`Unknown scenario: ${name}`);
		console.error(`Available: ${scenarioNames.join(", ")}`);
		process.exitCode = 1;
		return;
	}

	await runScenario(name, scenario);
}

await main();
