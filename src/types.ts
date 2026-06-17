/**
 * Domain types. See CONTEXT.md for the canonical definitions of each term.
 * These mirror the SQLite schema (db/schema.sql); JSON columns are parsed into
 * the shapes below by the store layer.
 */

/** Fixed, system-defined set of Event Types (resource.action form). */
export const EVENT_TYPES = [
	"order.created",
	"order.updated",
	"order.deleted",
	"payment.succeeded",
	"payment.failed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** `["*"]` means "all Event Types". */
export type EventTypeSubscription = EventType[] | ["*"];

export type EndpointState = "active" | "disabled";

export type DeliveryStatus =
	| "pending" // waiting to be attempted (or waiting out backoff)
	| "processing" // claimed by the worker, Attempt in flight
	| "delivered" // terminal: an Attempt succeeded (2xx)
	| "failed" // terminal: retries exhausted or a permanent error
	| "canceled"; // terminal: Endpoint was deleted/disabled before delivery

/** Behaviors a Sink can be created with, to exercise failure modes on demand. */
export type SinkBehavior =
	| "always-200"
	| "fail-then-recover"
	| "always-500"
	| "slow"
	| "410-gone"
	| "verify-signature";

export interface Endpoint {
	id: string; // ep_<uuid>
	url: string;
	secret: string;
	eventTypes: EventTypeSubscription;
	state: EndpointState;
	disabledAt: string | null;
	deletedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Event {
	id: string; // evt_<uuid>
	type: EventType;
	data: unknown; // opaque caller JSON object
	createdAt: string;
}

export interface Delivery {
	id: string; // dlv_<uuid>
	eventId: string;
	endpointId: string;
	status: DeliveryStatus;
	attemptCount: number;
	nextAttemptAt: string | null;
	claimedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Attempt {
	id: string; // att_<uuid>
	deliveryId: string;
	attemptNumber: number;
	statusCode: number | null;
	responseBody: string | null;
	error: string | null;
	durationMs: number;
	createdAt: string;
}

/** The serialized body POSTed to an Endpoint. Signature is computed over this. */
export interface DeliveryEnvelope {
	id: string; // the Event id — stable across retries; consumer dedup key
	type: EventType;
	created_at: string;
	data: unknown;
}
