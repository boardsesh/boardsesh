import type { DehydratedState } from '@tanstack/react-query';

/** `DehydratedQuery` is not exported by query-core; derive it from the state. */
export type PersistedQueryEntry = DehydratedState['queries'][number];

/**
 * Bump ONLY when the persisted *value* shape breaks (a changed envelope field, a
 * transform applied to `state.data`). A changed query KEY shape needs no bump:
 * a different key yields a different `queryHash`, so the stale entry is simply
 * never found and ages out under its rule's `maxAge`.
 *
 * A blob stamped with any other version parses as `unreadable: 'version'` and is
 * discarded, which is the intended migration story — this is a cache, not a
 * source of truth, so re-fetching once is the correct upgrade path.
 */
export const PERSISTED_CACHE_VERSION = 1;

/**
 * What lands on disk.
 *
 * **There is deliberately no `mutations` field.** `pending_mutations` in SQLite
 * is the outbox; a second persisted outbox is a genuine double-submit hazard.
 * The type makes it unrepresentable, and `dehydrateAllowlisted` additionally
 * hard-codes `shouldDehydrateMutation: () => false`. Two independent defences.
 */
export type PersistedCacheEnvelope = {
  readonly version: typeof PERSISTED_CACHE_VERSION;
  /** The account this blob belongs to. Re-checked against resolved auth before anything hydrates. */
  readonly userId: string;
  readonly savedAt: number;
  /** Set only when the write that produced this blob had to evict to fit the 512 KB cap. */
  readonly evicted?: true;
  readonly queries: readonly PersistedQueryEntry[];
};

export type ParsedCache =
  | { status: 'absent' }
  | { status: 'unreadable'; reason: 'json' | 'shape' | 'version' }
  | { status: 'ok'; envelope: PersistedCacheEnvelope };

export function serializePersistedCache(envelope: PersistedCacheEnvelope): string {
  return JSON.stringify(envelope);
}

export function parsePersistedCache(raw: string | null | undefined): ParsedCache {
  if (raw === null || raw === undefined || raw === '') return { status: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable', reason: 'json' };
  }

  if (typeof parsed !== 'object' || parsed === null) return { status: 'unreadable', reason: 'shape' };
  const candidate = parsed as Partial<PersistedCacheEnvelope>;
  // Version is checked before shape so a future build's envelope reads as a
  // version mismatch (expected, silent) rather than corruption (an alarm).
  if (candidate.version !== PERSISTED_CACHE_VERSION) return { status: 'unreadable', reason: 'version' };
  if (typeof candidate.userId !== 'string' || candidate.userId.length === 0) {
    return { status: 'unreadable', reason: 'shape' };
  }
  if (typeof candidate.savedAt !== 'number' || !Array.isArray(candidate.queries)) {
    return { status: 'unreadable', reason: 'shape' };
  }

  return {
    status: 'ok',
    envelope: {
      version: PERSISTED_CACHE_VERSION,
      userId: candidate.userId,
      savedAt: candidate.savedAt,
      ...(candidate.evicted === true ? { evicted: true as const } : {}),
      queries: candidate.queries,
    },
  };
}

/**
 * UTF-8 byte length, counted by hand rather than via `TextEncoder`.
 *
 * Same reasoning as `jwt-user-id.ts`'s hand-rolled `utf8Decode`: this runs on
 * Hermes, on Node (vitest) and in jsdom, and the budget assertions have to agree
 * across all three. A code-unit loop with explicit surrogate-pair handling is
 * deterministic everywhere; `TextEncoder`'s presence is not.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const trailUnit = value.charCodeAt(index + 1);
      if (trailUnit >= 0xdc00 && trailUnit <= 0xdfff) {
        // A well-formed surrogate pair is one 4-byte code point.
        bytes += 4;
        index += 1;
        continue;
      }
      // A lone high surrogate: JSON.stringify emits it as-is, and UTF-8
      // encoders substitute U+FFFD, which is 3 bytes either way.
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
