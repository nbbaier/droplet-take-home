/**
 * Prefixed, opaque IDs: `<prefix>_<uuid>`. The prefix makes logs and CLI output
 * self-describing; the UUID guarantees uniqueness with no wordlist or collision
 * checks. See ADR/PLAN — chosen over a "memorable" adjective-noun scheme.
 */

export const ID_PREFIX = {
	endpoint: "ep",
	event: "evt",
	delivery: "dlv",
	attempt: "att",
	sink: "sink",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export function newId(prefix: IdPrefix): string {
	return `${prefix}_${crypto.randomUUID()}`;
}
