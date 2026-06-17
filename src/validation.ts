/**
 * Request validation. The system owns id/created_at — callers only supply the
 * fields below. Parsed types flow into the store layer.
 */

import { z } from "zod";
import { EVENT_TYPES } from "./types";

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
