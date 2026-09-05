// Bounded recent-sender lookup for the climb currently displayed by a wall
// surface. Renderer-agnostic: the GraphQL I/O stays injected through the
// BoardPresenceClient context.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardClimbRecentSender } from '@boardsesh/shared-schema';
import { useBoardPresenceClient, useBoardPresenceFeed } from './board-presence-provider';
import type { BoardPresenceClient } from './types';

const RECENT_SENDER_CACHE_LIMIT = 50;
/**
 * Floor on the gap between two stats-triggered refetches. A busy gym board
 * republishes its stats on every tick from every climber, and the query is
 * budgeted at 60/min per connection — leading-edge-plus-trailing keeps the
 * first send after a quiet spell instant while collapsing a tick burst into at
 * most one request per window. Climb switches bypass it entirely.
 */
export const STATS_REFRESH_INTERVAL_MS = 2000;
const EMPTY_RECENT_SENDERS: BoardClimbRecentSender[] = [];
const EMPTY_RECENT_SENDERS_STATE = { senders: EMPTY_RECENT_SENDERS, isLoading: false };
const LOADING_RECENT_SENDERS_STATE = { senders: EMPTY_RECENT_SENDERS, isLoading: true };

export type BoardClimbRecentSendersOptions = {
  climbUuid: string | null | undefined;
  angle: number | null | undefined;
  /** Skip the lookup when a surface has shed the byline (for example compact kiosk chrome). */
  enabled?: boolean;
};

export type BoardClimbRecentSendersState = {
  senders: BoardClimbRecentSender[];
  isLoading: boolean;
};

type RecentSendersSnapshot = BoardClimbRecentSendersState & {
  cacheKey: string | null;
  client: BoardPresenceClient | null;
};

type RecentSendersRequestIdentity = {
  cacheKey: string;
  client: BoardPresenceClient;
};

const EMPTY_RECENT_SENDERS_SNAPSHOT: RecentSendersSnapshot = {
  cacheKey: null,
  client: null,
  ...EMPTY_RECENT_SENDERS_STATE,
};

function senderCacheKey(boardId: number, climbUuid: string, angle: number): string {
  return `${boardId}:${climbUuid}:${angle}`;
}

/**
 * Fetch recent senders for one displayed climb and keep them live with the
 * board's existing BoardStatsUpdated stream. Every tick save/update/delete
 * replaces the stats snapshot, which re-runs this effect without adding a
 * second subscription event type.
 */
export function useBoardClimbRecentSenders({
  climbUuid,
  angle,
  enabled = true,
}: BoardClimbRecentSendersOptions): BoardClimbRecentSendersState {
  const { boardId, client } = useBoardPresenceClient();
  const { stats } = useBoardPresenceFeed();
  const normalizedClimbUuid = climbUuid?.trim() ?? '';
  const canFetch =
    enabled &&
    boardId !== null &&
    client?.fetchClimbRecentSenders !== undefined &&
    normalizedClimbUuid.length > 0 &&
    angle !== null &&
    angle !== undefined &&
    Number.isInteger(angle) &&
    angle >= 0 &&
    angle <= 90;
  const currentCacheKey = canFetch ? senderCacheKey(boardId, normalizedClimbUuid, angle) : null;
  const [snapshot, setSnapshot] = useState<RecentSendersSnapshot>(EMPTY_RECENT_SENDERS_SNAPSHOT);
  const cacheRef = useRef(new Map<string, BoardClimbRecentSender[]>());
  const generationRef = useRef(0);
  const requestIdentityRef = useRef<RecentSendersRequestIdentity | null>(null);
  const lastRequestAtRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // `canFetch` already decides all of this, but it is a boolean — the compiler
    // still needs these narrowings to call through `boardId` / `angle` / the
    // optional client method below.
    if (
      currentCacheKey === null ||
      boardId === null ||
      client?.fetchClimbRecentSenders === undefined ||
      angle === null ||
      angle === undefined
    ) {
      generationRef.current += 1;
      requestIdentityRef.current = null;
      setSnapshot(EMPTY_RECENT_SENDERS_SNAPSHOT);
      return;
    }

    const fetchClimbRecentSenders = client.fetchClimbRecentSenders;
    const startRequest = () => {
      generationRef.current += 1;
      const requestGeneration = generationRef.current;
      lastRequestAtRef.current = Date.now();
      const cachedSenders = cacheRef.current.get(currentCacheKey);

      void fetchClimbRecentSenders(boardId, normalizedClimbUuid, angle)
        .then((nextSenders) => {
          if (!mountedRef.current || generationRef.current !== requestGeneration) return;
          // Refresh insertion order so the fixed-size map behaves as an LRU for
          // history scrubbing instead of growing for the lifetime of the kiosk.
          cacheRef.current.delete(currentCacheKey);
          cacheRef.current.set(currentCacheKey, nextSenders);
          if (cacheRef.current.size > RECENT_SENDER_CACHE_LIMIT) {
            const oldestKey = cacheRef.current.keys().next().value;
            if (oldestKey !== undefined) cacheRef.current.delete(oldestKey);
          }
          setSnapshot({ cacheKey: currentCacheKey, client, senders: nextSenders, isLoading: false });
        })
        .catch(() => {
          if (!mountedRef.current || generationRef.current !== requestGeneration) return;
          // No dedicated error chrome: a cached row remains useful during a
          // transient failure, while a first-load failure degrades to no byline.
          if (cachedSenders === undefined) {
            setSnapshot({
              cacheKey: currentCacheKey,
              client,
              senders: EMPTY_RECENT_SENDERS,
              isLoading: false,
            });
          }
        });
    };

    const previousIdentity = requestIdentityRef.current;
    const isIdentityChange = previousIdentity?.cacheKey !== currentCacheKey || previousIdentity.client !== client;
    requestIdentityRef.current = { cacheKey: currentCacheKey, client };

    if (isIdentityChange) {
      // A climb switch (or a new client) must never wait behind the throttle:
      // paint whatever is cached for the new identity and go straight out.
      const cachedSenders = cacheRef.current.get(currentCacheKey);
      setSnapshot({
        cacheKey: currentCacheKey,
        client,
        senders: cachedSenders ?? EMPTY_RECENT_SENDERS,
        isLoading: cachedSenders === undefined,
      });
      startRequest();
      return;
    }

    // Same climb, new stats snapshot. Leading edge if the window has already
    // elapsed, otherwise a trailing timer that each further stats event resets
    // — so a burst of ticks lands one refetch, not one per tick. In-flight
    // requests are left alone: the generation counter, not this cleanup,
    // decides which response is allowed to commit.
    const elapsedSinceLastRequest = Date.now() - lastRequestAtRef.current;
    if (elapsedSinceLastRequest >= STATS_REFRESH_INTERVAL_MS) {
      startRequest();
      return;
    }

    const trailingRefresh = setTimeout(startRequest, STATS_REFRESH_INTERVAL_MS - elapsedSinceLastRequest);
    return () => clearTimeout(trailingRefresh);
    // The stats object is intentionally a dependency: the provider replaces it
    // for every BoardStatsUpdated event, including edits and deletes where a
    // scalar such as lastSentAt may stay unchanged.
  }, [angle, boardId, client, currentCacheKey, normalizedClimbUuid, stats]);

  return useMemo(() => {
    if (currentCacheKey === null) return EMPTY_RECENT_SENDERS_STATE;
    if (snapshot.cacheKey !== currentCacheKey || snapshot.client !== client) return LOADING_RECENT_SENDERS_STATE;
    return { senders: snapshot.senders, isLoading: snapshot.isLoading };
  }, [client, currentCacheKey, snapshot]);
}
