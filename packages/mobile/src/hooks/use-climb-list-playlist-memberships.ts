import { useEffect, useRef } from 'react';
import { scheduleIdleTask } from '../lib/schedule-idle-task';
import { useQueryClient } from '@tanstack/react-query';
import {
  GET_PLAYLISTS_FOR_CLIMBS,
  type GetPlaylistsForClimbsQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { playlistMembershipStore } from '@boardsesh/climb-actions';
import { offlineAwareRequest } from '../lib/graphql/offline-request';
import { getCredentialGeneration } from '../lib/privacy/privacy-cache';
import { useAuth } from '../providers/auth-provider';
import { useClimbRowField } from '../lib/climb-row-display-preference';
import { useStoredUserId } from './use-current-user-id';
import { useUserReadRefresh } from './use-user-read-refresh';
import { isPlaylistMembershipWritePending } from '../lib/graphql/offline-user-read-recovery';

// The backend caps `climbUuids` per request; chunk longer visible sets.
const CHUNK_SIZE = 500;

type UseClimbListPlaylistMembershipsArgs = {
  boardName: string;
  layoutId: number;
  // Must be a referentially-stable array (memoize at the call site) — the effect
  // depends on it, so a fresh array every render would refetch every render.
  climbUuids: readonly string[];
};

/**
 * Feed the shared `playlistMembershipStore` with the playlist membership of the
 * currently-visible climbs, so `ClimbPlaylistChips` rows can render tags. The
 * mobile analog of web's incremental `GET_PLAYLISTS_FOR_CLIMBS` fetch, written
 * to the established "fetch the visible UUIDs, write into the external store"
 * pattern (see the favorites note in `use-mobile-climb-actions-data.ts`).
 *
 * No-op unless the user enabled the setting AND is signed in. Dedupes via a ref
 * so each climb is requested once; resets the ref and clears the store whenever
 * the board/layout/auth/enabled context flips, so a previous board's memberships
 * can't paint the new board's rows. Deferred until the JS thread has idle time
 * after a frame paints.
 */
export function useClimbListPlaylistMemberships({
  boardName,
  layoutId,
  climbUuids,
}: UseClimbListPlaylistMembershipsArgs): void {
  const enabled = useClimbRowField('playlistTags');
  const { isAuthenticated } = useAuth();
  const { userId, isLoading: isUserIdLoading } = useStoredUserId(isAuthenticated && enabled);
  const refreshEpoch = useUserReadRefresh('playlists');
  const queryClient = useQueryClient();

  const fetchedRef = useRef<Set<string>>(new Set());
  const contextKey = `${userId ?? 'anonymous'}:${boardName}:${layoutId}:${enabled ? 1 : 0}:${isAuthenticated ? 1 : 0}`;
  const contextKeyRef = useRef(contextKey);

  // Reset before any fetch when the context changes. Runs in the same render
  // pass via the effect ordering below (this effect is declared first).
  useEffect(() => {
    if (contextKeyRef.current === contextKey) return;
    contextKeyRef.current = contextKey;
    fetchedRef.current = new Set();
    playlistMembershipStore.reset();
  }, [contextKey]);

  useEffect(() => {
    fetchedRef.current = new Set();
  }, [refreshEpoch]);

  useEffect(() => {
    if (!enabled || !isAuthenticated || isUserIdLoading || !userId || layoutId <= 0 || climbUuids.length === 0) return;
    const toFetch = climbUuids.filter((uuid) => !fetchedRef.current.has(uuid));
    if (toFetch.length === 0) return;

    let cancelled = false;
    const fetchedForContext = fetchedRef.current;
    const credentialGeneration = getCredentialGeneration();
    let mergedCount = 0;
    const releaseUnmerged = () => {
      for (const uuid of toFetch.slice(mergedCount)) fetchedForContext.delete(uuid);
    };
    const handle = scheduleIdleTask(async () => {
      // Mark up-front so an overlapping effect run doesn't double-request the
      // same uuids while this batch is in flight.
      for (const uuid of toFetch) fetchedForContext.add(uuid);
      try {
        for (let offset = 0; offset < toFetch.length; offset += CHUNK_SIZE) {
          const chunk = toFetch.slice(offset, offset + CHUNK_SIZE);
          const hasPendingWrite = (climbUuid: string) =>
            isPlaylistMembershipWritePending(queryClient, ['playlistsForClimb', boardName, layoutId, climbUuid]);
          const protectedBeforeRequest = new Set(chunk.filter(hasPendingWrite));
          const membershipsBeforeRequest = new Map(
            chunk.map((climbUuid) => [climbUuid, playlistMembershipStore.getMembershipsForClimb(climbUuid)]),
          );
          const response = await offlineAwareRequest<GetPlaylistsForClimbsQueryResponse>(GET_PLAYLISTS_FOR_CLIMBS, {
            input: { boardType: boardName, layoutId, climbUuids: chunk },
          });
          if (cancelled || getCredentialGeneration() !== credentialGeneration) return;
          const memberships = new Map(
            response.playlistsForClimbs.map((entry) => [entry.climbUuid, entry.playlistUuids]),
          );
          // An omitted climb has no memberships. Clear its old tags as well.
          playlistMembershipStore.setMembershipsFor(
            chunk
              .filter(
                (climbUuid) =>
                  !protectedBeforeRequest.has(climbUuid) &&
                  !hasPendingWrite(climbUuid) &&
                  playlistMembershipStore.getMembershipsForClimb(climbUuid) === membershipsBeforeRequest.get(climbUuid),
              )
              .map((climbUuid) => ({
                climbUuid,
                playlistUuids: memberships.get(climbUuid) ?? [],
              })),
          );
          mergedCount = offset + chunk.length;
        }
      } catch {
        // A failed batch must not wedge future fetches — drop these uuids so a
        // later scroll or refresh retries them.
        releaseUnmerged();
      }
    });

    return () => {
      cancelled = true;
      handle.cancel();
      releaseUnmerged();
    };
  }, [enabled, isAuthenticated, isUserIdLoading, userId, boardName, layoutId, climbUuids, refreshEpoch, queryClient]);
}
