import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { logbookClimbAngleKey, useLogbook, type LogbookEntry } from '@boardsesh/board-react';
import { canServeLocalUserData } from '@boardsesh/offline-sync';
import type { BoardName } from '@boardsesh/shared-schema';
import { getDatabaseHandle, subscribeDatabaseHandle } from '../db/connection';
import { readClimbTicksLocal } from '../db/queries/get-climb-ticks-local';
import { usePrivacyCredentialScope } from '../hooks/use-privacy-scoped-state';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { readLocalUserId } from '../lib/local-user-id';
import { useAuth } from './auth-provider';
import { useOfflineDownloadsEnabled } from './feature-flags-provider';
import { ClimbListTickDisplayContext, type ClimbListTickDisplay } from './climb-list-tick-display-context';

const NO_CLIMBS: string[] = [];
const NO_COVERAGE: ReadonlySet<string> = new Set();
const serverDatabaseSnapshot = () => null;
const databaseScopes = new WeakMap<object, number>();
let nextDatabaseScope = 1;

function databaseScopeOf(database: NonNullable<ReturnType<typeof getDatabaseHandle>>): number {
  const existing = databaseScopes.get(database);
  if (existing !== undefined) return existing;
  const scope = nextDatabaseScope++;
  databaseScopes.set(database, scope);
  return scope;
}

export function climbListTicksQueryKey(
  boardName: BoardName | null,
  viewerId: string | undefined,
  credentialScope: number,
  climbUuids: readonly string[],
  databaseScope = 0,
) {
  return ['localTicks', 'list', boardName, viewerId ?? '', credentialScope, climbUuids, databaseScope] as const;
}

/**
 * Own the list's network observer, so opening a drawer cannot replace its
 * pending UUID batch. Local ticks are a display fallback, never written into
 * the shared server logbook or its authoritative fetched-climb marker.
 */
export function ClimbListTickDisplayProvider({
  boardName,
  climbUuids,
  children,
}: {
  boardName: BoardName | null;
  climbUuids: readonly string[];
  children: ReactNode;
}) {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const offlineEnabled = useOfflineDownloadsEnabled();
  const credentialScope = usePrivacyCredentialScope();
  const database = useSyncExternalStore(subscribeDatabaseHandle, getDatabaseHandle, serverDatabaseSnapshot);
  const databaseScope = database ? databaseScopeOf(database) : 0;
  const requestedUuids = useMemo(() => [...new Set(climbUuids)].sort(), [climbUuids]);
  const { logbook, fetchedUuids } = useLogbook(boardName, isAuthenticated ? requestedUuids : NO_CLIMBS);
  const wantsLocal =
    isAuthenticated && !isAuthLoading && offlineEnabled && boardName !== null && requestedUuids.length > 0;

  // Unlike a profile request, local identity must also resolve on a cold
  // offline launch. A credential-scoped key cannot reuse the previous viewer.
  const { data: identity } = useQuery({
    queryKey: ['localTicks', 'list-viewer', credentialScope],
    enabled: wantsLocal,
    networkMode: 'always',
    staleTime: (query) => (query.state.data === null ? 0 : Infinity),
    queryFn: async () => {
      const authEpoch = captureAuthCredentialGeneration();
      const viewerId = await readLocalUserId();
      return viewerId && isAuthCredentialGenerationCurrent(authEpoch) ? { viewerId, authEpoch } : null;
    },
  });
  const viewerId = identity && isAuthCredentialGenerationCurrent(identity.authEpoch) ? identity.viewerId : undefined;
  const { data: localSnapshot } = useQuery({
    queryKey: climbListTicksQueryKey(boardName, viewerId, credentialScope, requestedUuids, databaseScope),
    // Keep an unavailable snapshot in the cache from the start. React Query
    // can then replace an in-flight read on sync invalidation, rather than
    // deduplicating onto a read whose completeness gate already declined.
    initialData: null,
    enabled: wantsLocal && database !== null && viewerId !== undefined,
    networkMode: 'always',
    retry: false,
    staleTime: (query) => (query.state.data === null ? 0 : Infinity),
    queryFn: async () => {
      if (!database || !boardName || !viewerId) return null;
      const authEpoch = captureAuthCredentialGeneration();
      if ((await readLocalUserId()) !== viewerId || !isAuthCredentialGenerationCurrent(authEpoch)) return null;
      const entries = await readClimbTicksLocal(database, boardName, requestedUuids, viewerId);
      if (
        entries === null ||
        !isAuthCredentialGenerationCurrent(authEpoch) ||
        getDatabaseHandle() !== database ||
        (await readLocalUserId()) !== viewerId ||
        !(await canServeLocalUserData(database, viewerId)) ||
        !isAuthCredentialGenerationCurrent(authEpoch)
      )
        return null;
      return { entries, authEpoch, database };
    },
  });
  const localEntries =
    wantsLocal && localSnapshot?.database === database && isAuthCredentialGenerationCurrent(localSnapshot.authEpoch)
      ? localSnapshot.entries
      : undefined;

  const display = useMemo<ClimbListTickDisplay>(() => {
    const entriesByUuid = new Map<string, LogbookEntry>();
    const revisionsByTickUuid = new Map<string, number | null>();
    // A server answer, including an empty one, replaces local placeholders.
    for (const entry of localEntries ?? []) {
      if (entry.climb_revision !== undefined) revisionsByTickUuid.set(entry.uuid, entry.climb_revision);
      if (!fetchedUuids.has(entry.climb_uuid)) entriesByUuid.set(entry.uuid, entry);
    }
    // Cached payloads win, while local revision knowledge fills a field that
    // GET_TICKS may not carry. This never resurrects a local-only tick.
    if (isAuthenticated)
      for (const entry of logbook) {
        const localRevision = revisionsByTickUuid.get(entry.uuid);
        const enrichedEntry =
          typeof entry.climb_revision !== 'number' && localRevision !== undefined
            ? { ...entry, climb_revision: localRevision }
            : entry;
        entriesByUuid.set(entry.uuid, enrichedEntry);
      }
    const entriesByClimbAngle = new Map<string, LogbookEntry[]>();
    for (const entry of entriesByUuid.values()) {
      const key = logbookClimbAngleKey(entry.climb_uuid, entry.angle);
      const bucket = entriesByClimbAngle.get(key);
      if (bucket) bucket.push(entry);
      else entriesByClimbAngle.set(key, [entry]);
    }
    return {
      entriesByClimbAngle,
      coveredClimbUuids: localEntries === undefined ? NO_COVERAGE : new Set(requestedUuids),
    };
  }, [isAuthenticated, localEntries, logbook, fetchedUuids, requestedUuids]);

  return <ClimbListTickDisplayContext.Provider value={display}>{children}</ClimbListTickDisplayContext.Provider>;
}
