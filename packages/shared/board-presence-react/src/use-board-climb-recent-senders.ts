// Bounded recent-sender lookup for the climb currently displayed by a wall
// surface. Renderer-agnostic: the GraphQL I/O stays injected through the
// BoardPresenceClient context.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardClimbRecentSender } from '@boardsesh/shared-schema';
import { useBoardPresenceClient, useBoardPresenceFeed } from './board-presence-provider';
import type { BoardPresenceClient } from './types';

const RECENT_SENDER_CACHE_LIMIT = 50;
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

  useEffect(() => {
    generationRef.current += 1;
    const requestGeneration = generationRef.current;
    if (
      currentCacheKey === null ||
      boardId === null ||
      client?.fetchClimbRecentSenders === undefined ||
      angle === null ||
      angle === undefined
    ) {
      setSnapshot(EMPTY_RECENT_SENDERS_SNAPSHOT);
      return;
    }

    const cachedSenders = cacheRef.current.get(currentCacheKey);
    setSnapshot({
      cacheKey: currentCacheKey,
      client,
      senders: cachedSenders ?? EMPTY_RECENT_SENDERS,
      isLoading: cachedSenders === undefined,
    });
    let active = true;

    void client
      .fetchClimbRecentSenders(boardId, normalizedClimbUuid, angle)
      .then((nextSenders) => {
        if (!active || generationRef.current !== requestGeneration) return;
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
        if (!active || generationRef.current !== requestGeneration) return;
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

    return () => {
      active = false;
    };
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
