import type { QueryClient } from '@tanstack/react-query';
import { SHARED_EVENTS, type AnalyticsEventProperties } from '@boardsesh/analytics';
import { track } from '../analytics';
import { reportHandledError } from '../error-reporting';
import type { UserStorageOwner } from '../user-storage-owner';
import { getLastRestore, getPersistOwner, markRestoreReported, setLastRestore, setPersistOwner } from './runtime';
import { restorePersistedCache, type RestoreOutcome } from './restore';
import { SUPPORTS_SYNC_RESTORE, clearPersistedQueryCache, readPersistedCacheAsync, writeCacheOwner } from './storage';

export type OwnerTransition = 'adopt' | 'evict-then-adopt' | 'evict';

/**
 * Pure. `resolvedUserId === undefined` → `evict`: we cannot prove who this
 * device belongs to, so we do not serve the blob. Otherwise adopt, evicting
 * first when the blob is stamped with someone else.
 */
export function decideOwnerTransition(input: {
  resolvedUserId: string | undefined;
  hydratedUserId: string | undefined;
}): OwnerTransition {
  if (input.resolvedUserId === undefined) return 'evict';
  if (input.hydratedUserId === undefined) return 'adopt';
  return input.hydratedUserId === input.resolvedUserId ? 'adopt' : 'evict-then-adopt';
}

function restoreEventProperties(outcome: RestoreOutcome): AnalyticsEventProperties {
  // Absent-when-unknown throughout, never 0-when-unknown. `entryCount` and
  // `bytes` are facts only when the blob was actually parsed and owned; on
  // `unreadable` / `owner_mismatch` / `owner_missing` nothing was inspected, so
  // the honest answer is "no property".
  const measured = outcome.outcome === 'hydrated' || outcome.outcome === 'empty';
  return {
    outcome: outcome.outcome,
    ...(measured ? { entryCount: outcome.entryCount, bytes: outcome.bytes } : {}),
    ...(outcome.droppedCount > 0 ? { droppedCount: outcome.droppedCount } : {}),
    ...(outcome.outcome === 'hydrated' && outcome.oldestEntryAgeHours !== undefined
      ? { oldestEntryAgeHours: outcome.oldestEntryAgeHours }
      : {}),
    ...(outcome.evicted === true ? { evicted: true } : {}),
  };
}

/**
 * Reconcile the persisted cache with the account auth just resolved.
 *
 * @param owner ALWAYS pass `undefined` from the auth boundary. This runs after
 * `handleAuthenticatedTransition` has called `setCurrentUserStorageOwner`, so
 * `undefined` resolves the account that just authenticated. Passing an
 * explicitly captured owner is the bug this comment exists to prevent: on web a
 * pre-transition owner is `null` on every cold start, and
 * `userScopedStorageKey(base, null)` returns null — the read, and the
 * mismatch-path delete, would both silently no-op.
 */
export async function adoptPersistedQueryCache(
  client: QueryClient,
  resolvedUserId: string | undefined,
  owner?: UserStorageOwner | null,
): Promise<void> {
  // Idempotence gate. `checkAuth` runs on every foreground, so without this a
  // day-old blob would be re-hydrated over a live session (resurrecting entries
  // that session had invalidated) and an in-launch account switch would re-fire
  // the owner-mismatch alarm on every foreground after it.
  if (resolvedUserId !== undefined && getPersistOwner() === resolvedUserId) return;

  let restore: RestoreOutcome | null;
  if (SUPPORTS_SYNC_RESTORE) {
    // Native already restored synchronously in QueryProvider's lazy initializer.
    restore = getLastRestore();
  } else if (resolvedUserId === undefined) {
    restore = null;
  } else {
    restore = restorePersistedCache(client, {
      raw: await readPersistedCacheAsync(owner),
      ownerHint: resolvedUserId,
      requireOwnerHint: false,
      now: Date.now(),
    });
    setLastRestore(restore);
  }

  const transition = decideOwnerTransition({
    // The blob's OWN stamp, whatever the outcome — that is what decides whether
    // the bytes on disk belong to the account auth just resolved.
    resolvedUserId,
    hydratedUserId: restore?.userId,
  });
  // A blob that exists but did not hydrate — a torn write, a corrupted or
  // future-versioned file, or one whose entries have all aged out — is dead
  // weight that will never be read again, so it goes too.
  const hasUnusableBlob = restore !== null && restore.outcome !== 'absent' && restore.outcome !== 'hydrated';
  // The P0 alarm: bytes on this device belong to an account other than the one
  // auth just resolved, which means a sign-out wipe failed. Two ways to see it —
  // the blob's stamp disagreeing with resolved auth (`evict-then-adopt`), and
  // the restore having already caught the stamp disagreeing with the platform's
  // owner hint. `owner_missing` is a torn write, not a leak, and stays silent so
  // this signal keeps meaning something.
  const ownerDisagreement = transition === 'evict-then-adopt' || restore?.outcome === 'owner_mismatch';

  if (transition !== 'adopt' || hasUnusableBlob) {
    if (restore) {
      // Precise removal, not `client.clear()`: anything legitimately fetched
      // since the restore must survive.
      for (const queryHash of restore.hydratedHashes) {
        client.removeQueries({ predicate: (query) => query.queryHash === queryHash });
      }
    }
    await clearPersistedQueryCache(owner);
    if (ownerDisagreement) {
      reportHandledError(new Error('Persisted query cache owner mismatch'), {
        tags: { source: 'query-persist' },
      });
    }
  }

  if (transition !== 'evict' && resolvedUserId !== undefined) {
    setPersistOwner(resolvedUserId);
    writeCacheOwner(resolvedUserId);
  }

  // Fired at most once per launch, and only when a blob existed at all, so a
  // first-run or signed-out launch emits nothing.
  if (restore && restore.outcome !== 'absent' && markRestoreReported()) {
    track(
      SHARED_EVENTS.OfflineQueryCacheRestored,
      // An owner disagreement is reported as such even when the restore itself
      // said 'hydrated' — those entries were evicted again moments later, so
      // calling the launch 'hydrated' would hide the alarm from the funnel.
      ownerDisagreement ? { outcome: 'owner_mismatch' as const } : restoreEventProperties(restore),
    );
  }

  // Consumed. A later transition must see "nothing was restored" rather than
  // re-deciding against a user who has already left.
  setLastRestore(null);
}
