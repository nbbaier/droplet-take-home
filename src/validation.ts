/**
 * Request validation. The system owns id/created_at — callers only supply the
 * fields below. Parsed types flow into the store layer.
 */

import { z } from "zod";
import { EVENT_TYPES } from "./types";

/** Behaviors a Sink can be created with (mirrors the SinkBehavior union). */
export const sinkBehaviorSchema = z.enum([
	"always-200",
	"fail-then-recover",
	"always-500",
	"slow",
	"410-gone",
	"verify-signature",
]);

export const eventTypeSchema = z.enum(EVENT_TYPES);

/** Body for POST /events: caller supplies type + opaque data object only. */
export const ingestSchema = z.object({
	type: eventTypeSchema,
	data: z.record(z.string(), z.unknown()),
});
export type IngestInput = z.infer<typeof ingestSchema>;

/**
 * Subscription is a flat array of Event Types, or exactly ["*"] for all.
 * (Mixing "*" with specific types is rejected to keep matching unambiguous.)
 */
export const subscriptionSchema = z.union([
	z.tuple([z.literal("*")]),
	z.array(eventTypeSchema).nonempty(),
]);

/** Body for POST /endpoints: register an arbitrary external URL. */
export const registerEndpointSchema = z.object({
	url: z.url(),
	eventTypes: subscriptionSchema,
});
export type RegisterEndpointInput = z.infer<typeof registerEndpointSchema>;

/**
 * Body for POST /sinks: pick a Behavior; optionally narrow which Event Types the
 * auto-registered Endpoint subscribes to (defaults to all, ["*"]).
 */
export const createSinkSchema = z.object({
	behavior: sinkBehaviorSchema,
	eventTypes: subscriptionSchema.optional(),
});
export type CreateSinkInput = z.infer<typeof createSinkSchema>;
