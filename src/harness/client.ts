/**
 * Thin HTTP client over the daemon's API. The harness and tests drive the system
 * exclusively through these helpers — never the store/DB directly (ADR 0002).
 *
 * Shapes mirror the server responses (see src/server.ts). These are intentionally
 * loose (`any`/structural) so the scenarios stay readable; the asserted tests pin
 * down the fields they care about.
 */

import type {
	Attempt,
	Delivery,
	DeliveryStatus,
	Endpoint,
	EventType,
	EventTypeSubscription,
	Sink,
	SinkBehavior,
} from "../types";

/** Delivery + its full Attempt timeline, as returned by GET /deliveries/:id. */
export interface DeliveryWithAttempts extends Delivery {
	attempts: Attempt[];
}

const TERMINAL: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
	"delivered",
	"failed",
	"canceled",
]);

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
	}
	return (await res.json()) as T;
}

/** Register an Endpoint pointing at an arbitrary external URL. */
export async function registerEndpoint(
	baseUrl: string,
	input: { url: string; eventTypes: EventTypeSubscription },
): Promise<Endpoint> {
	const res = await fetch(`${baseUrl}/endpoints`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return json<Endpoint>(res);
}

/** List all (non-deleted) Endpoints. */
export async function listEndpoints(baseUrl: string): Promise<Endpoint[]> {
	return json<Endpoint[]>(await fetch(`${baseUrl}/endpoints`));
}

/**
 * Create a Sink with a chosen Behavior (and optional event-type narrowing). The
 * daemon auto-registers an Endpoint pointing back at its own /_sink/:id route.
 */
export async function createSink(
	baseUrl: string,
	input: { behavior: SinkBehavior; eventTypes?: EventTypeSubscription },
): Promise<{ sink: Sink; endpoint: Endpoint }> {
	const res = await fetch(`${baseUrl}/sinks`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return json<{ sink: Sink; endpoint: Endpoint }>(res);
}

/** Ingest an Event; the daemon fans out one Delivery per matching Endpoint. */
export async function emitEvent(
	baseUrl: string,
	input: { type: EventType; data: Record<string, unknown> },
): Promise<{ event: { id: string; type: EventType }; deliveryCount: number }> {
	const res = await fetch(`${baseUrl}/events`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return json<{
		event: { id: string; type: EventType };
		deliveryCount: number;
	}>(res);
}

/** All Deliveries, newest first. */
export async function listDeliveries(baseUrl: string): Promise<Delivery[]> {
	return json<Delivery[]>(await fetch(`${baseUrl}/deliveries`));
}

/**
 * Deliveries for a single Endpoint. The test daemon shares one DB across all
 * tests (config is frozen at first import, so per-test daemons aren't possible),
 * so scope assertions to the Endpoint you created rather than the global list.
 */
export async function deliveriesFor(
	baseUrl: string,
	endpointId: string,
): Promise<Delivery[]> {
	const all = await listDeliveries(baseUrl);
	return all.filter((d) => d.endpointId === endpointId);
}

/** One Delivery plus its Attempt timeline. */
export async function getDeliveryWithAttempts(
	baseUrl: string,
	id: string,
): Promise<DeliveryWithAttempts> {
	return json<DeliveryWithAttempts>(await fetch(`${baseUrl}/deliveries/${id}`));
}

/**
 * Poll GET /deliveries until the relevant Deliveries are all in a terminal state
 * (delivered/failed/canceled) or the timeout elapses. Returns the final list,
 * scoped to `endpointId` when given.
 *
 * Throws on timeout so a scenario/test never silently asserts against a
 * still-in-flight queue. `expectedCount` (optional) also waits for at least that
 * many (scoped) Deliveries to exist first, guarding the race where we poll before
 * fan-out rows are visible.
 *
 * Pass `endpointId` to scope to one Endpoint — important because the test daemon
 * shares one DB across tests, so the global list mixes deliveries from every test.
 */
export async function waitForSettled(
	baseUrl: string,
	opts: {
		timeout?: number;
		pollMs?: number;
		expectedCount?: number;
		endpointId?: string;
	} = {},
): Promise<Delivery[]> {
	const timeout = opts.timeout ?? 5_000;
	const pollMs = opts.pollMs ?? 25;
	const deadline = Date.now() + timeout;

	for (;;) {
		const all = await listDeliveries(baseUrl);
		const deliveries =
			opts.endpointId === undefined
				? all
				: all.filter((d) => d.endpointId === opts.endpointId);
		const enough =
			opts.expectedCount === undefined ||
			deliveries.length >= opts.expectedCount;
		const allTerminal =
			deliveries.length > 0 && deliveries.every((d) => TERMINAL.has(d.status));

		if (enough && allTerminal) return deliveries;

		if (Date.now() > deadline) {
			const summary = deliveries.map((d) => `${d.id}=${d.status}`).join(", ");
			throw new Error(
				`waitForSettled timed out after ${timeout}ms; ` +
					`deliveries (${deliveries.length}): [${summary}]`,
			);
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
}

export { TERMINAL };
