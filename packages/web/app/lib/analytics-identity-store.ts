import type { AliasDedupeStore } from '@boardsesh/analytics';
import { createIndexedDBStore } from './idb-helper';

const DB_NAME = 'boardsesh-analytics-identity';
const STORE_NAME = 'identity';
const RECORD_KEY = 'posthog';
const MAX_STORED_ALIAS_PAIRS = 64;

/**
 * What this browser has already told PostHog about who it is.
 *
 * `identifiedUserId` is the authenticated user id the PostHog client was last
 * switched to, or `null` while it is anonymous. It is the one fact the SDK
 * cannot answer for us: `posthog.getDistinctId()` returns the persisted
 * distinct id but not whether that id is an anonymous one or a user id, and
 * telling those apart is what stops a second user on the same browser from
 * being aliased onto the first user's anonymous id (which PostHog resolves by
 * merging the two people).
 */
export type AnalyticsIdentityRecord = {
  identifiedUserId: string | null;
  aliasPairs: string[];
};

export type AnalyticsIdentityStorage = {
  read(): Promise<unknown>;
  write(record: AnalyticsIdentityRecord): Promise<void>;
};

export type AnalyticsIdentityStore = {
  /** Loads the persisted record into the synchronous mirror. Safe to call repeatedly. */
  hydrate(): Promise<void>;
  getIdentifiedUserId(): string | null;
  setIdentifiedUserId(userId: string | null): void;
  aliasStore: AliasDedupeStore;
};

function aliasPairKey(anonymousId: string, userId: string): string {
  return `${anonymousId}->${userId}`;
}

function parseRecord(raw: unknown): AnalyticsIdentityRecord {
  const empty: AnalyticsIdentityRecord = { identifiedUserId: null, aliasPairs: [] };
  if (typeof raw !== 'object' || raw === null) return empty;
  const candidate = raw as Partial<AnalyticsIdentityRecord>;
  const identifiedUserId = typeof candidate.identifiedUserId === 'string' ? candidate.identifiedUserId : null;
  const aliasPairs = Array.isArray(candidate.aliasPairs)
    ? candidate.aliasPairs.filter((pair): pair is string => typeof pair === 'string')
    : [];
  return { identifiedUserId, aliasPairs };
}

/**
 * `reconcileAnalyticsIdentity` drives the identity transition from inside a
 * React effect, so it needs a SYNCHRONOUS view of this state — but CLAUDE.md
 * mandates IndexedDB for client persistence and IndexedDB is async. Same shape
 * as mobile's AsyncStorage-backed alias store: an in-memory mirror is the
 * synchronous source of truth, hydrated and persisted in the background. A lost
 * write costs at worst one duplicate `$create_alias`, which PostHog tolerates.
 *
 * The predecessor of this file (`posthog-alias-storage.ts`, deleted with the
 * W-16 chrome teardown) reached for `localStorage` and a third
 * `no-restricted-globals` suppression instead. The two suppressions that remain
 * in the codebase both exist because nothing else can serve the read — a
 * pre-paint inline script, and a one-time migration off localStorage itself.
 * Neither applies here: an in-memory mirror serves the synchronous read
 * perfectly well, so this stays on IndexedDB.
 */
export function createAnalyticsIdentityStore(storage: AnalyticsIdentityStorage): AnalyticsIdentityStore {
  let identifiedUserId: string | null = null;
  const recordedAliasPairs = new Set<string>();
  let hydratePromise: Promise<void> | null = null;

  function persist(): void {
    void storage.write({ identifiedUserId, aliasPairs: [...recordedAliasPairs] }).catch(() => {
      // Best-effort: the in-memory mirror still holds for this page load.
    });
  }

  return {
    hydrate(): Promise<void> {
      if (!hydratePromise) {
        hydratePromise = storage
          .read()
          .then((raw) => {
            const record = parseRecord(raw);
            identifiedUserId = record.identifiedUserId;
            for (const pair of record.aliasPairs) recordedAliasPairs.add(pair);
          })
          .catch(() => {
            // Blocked or corrupt storage — start from an empty mirror rather
            // than blocking analytics identity entirely.
          });
      }
      return hydratePromise;
    },

    getIdentifiedUserId(): string | null {
      return identifiedUserId;
    },

    setIdentifiedUserId(userId: string | null): void {
      if (identifiedUserId === userId) return;
      identifiedUserId = userId;
      persist();
    },

    aliasStore: {
      hasRecordedAlias(anonymousId: string, userId: string): boolean {
        return recordedAliasPairs.has(aliasPairKey(anonymousId, userId));
      },
      recordAlias(anonymousId: string, userId: string): void {
        const pairKey = aliasPairKey(anonymousId, userId);
        if (recordedAliasPairs.has(pairKey)) return;
        recordedAliasPairs.add(pairKey);
        // Bound the set so a shared browser that churns through identities
        // can't grow it forever; evict oldest (insertion order).
        while (recordedAliasPairs.size > MAX_STORED_ALIAS_PAIRS) {
          const oldest = recordedAliasPairs.values().next().value;
          if (oldest === undefined) break;
          recordedAliasPairs.delete(oldest);
        }
        persist();
      },
    },
  };
}

const getDB = createIndexedDBStore(DB_NAME, STORE_NAME);

const indexedDbStorage: AnalyticsIdentityStorage = {
  async read(): Promise<unknown> {
    const db = await getDB();
    if (!db) return null;
    return db.get(STORE_NAME, RECORD_KEY);
  },
  async write(record: AnalyticsIdentityRecord): Promise<void> {
    const db = await getDB();
    if (!db) return;
    await db.put(STORE_NAME, record, RECORD_KEY);
  },
};

export const analyticsIdentityStore = createAnalyticsIdentityStore(indexedDbStorage);
