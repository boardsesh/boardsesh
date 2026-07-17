// Pure predicate for a queue climb's resolution state — no expo/native imports,
// so it's safe to pull into the shared visual (`ClimbListItemContent`) whose
// tests don't mock expo-crypto. Lives apart from `climb-to-queue-item.ts` for
// exactly that reason (that module imports `randomUUID` from expo-crypto).

// The minimum a queue climb needs to render (name, thumbnail) AND to be a valid
// `ClimbInput` for a peer broadcast (`name`/`frames` are `String!` server-side).
type ResolvableClimb = { uuid?: string | null; name?: string | null; frames?: string | null } | null | undefined;

/**
 * Whether a queue item's climb is fully resolved: it carries the uuid, name, and
 * frames the row/thumbnail render and a `ClimbInput` requires. A party peer can
 * broadcast a queue item whose climb arrived partially synced (missing details,
 * or only an item shell), and the wire boundary is untyped despite
 * `ClimbQueueItem.climb` being declared non-null — so guard with this before
 * rendering or re-broadcasting. An unresolved-but-uuid'd climb is re-fetched by
 * `useQueueResolveClimbs`; a uuid-less one is genuinely unresolvable (#2527).
 */
export function isClimbResolved(climb: ResolvableClimb): boolean {
  return !!climb && !!climb.uuid && !!climb.name && !!climb.frames;
}
