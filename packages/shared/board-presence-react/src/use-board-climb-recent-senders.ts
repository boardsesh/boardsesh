// Bounded recent-sender lookup for the climb currently displayed by a wall
// surface. Renderer-agnostic: the GraphQL I/O stays injected through the
// BoardPresenceClient context.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardClimbRecentSender } from '@boardsesh/shared-schema';
import { useBoardPresenceClient, useBoardPresenceFeed } from './board-presence-provider';

const RECENT_SENDER_CACHE_LIMIT = 50;
const EMPTY_RECENT_SENDERS: BoardClimbRecentSender[] = [];

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
  const [senders, setSenders] = useState<BoardClimbRecentSender[]>(EMPTY_RECENT_SENDERS);
  const [isLoading, setIsLoading] = useState(false);
  const cacheRef = useRef(new Map<string, BoardClimbRecentSender[]>());
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    const requestGeneration = generationRef.current;
    const normalizedClimbUuid = climbUuid?.trim() ?? '';
    if (
      !enabled ||
      boardId === null ||
      client?.fetchClimbRecentSenders === undefined ||
      normalizedClimbUuid.length === 0 ||
      angle === null ||
      angle === undefined ||
      !Number.isInteger(angle) ||
      angle < 0 ||
      angle > 90
    ) {
      setSenders(EMPTY_RECENT_SENDERS);
      setIsLoading(false);
      return;
    }

    const cacheKey = senderCacheKey(boardId, normalizedClimbUuid, angle);
    const cachedSenders = cacheRef.current.get(cacheKey);
    setSenders(cachedSenders ?? EMPTY_RECENT_SENDERS);
    setIsLoading(cachedSenders === undefined);
    let active = true;

    void client
      .fetchClimbRecentSenders(boardId, normalizedClimbUuid, angle)
      .then((nextSenders) => {
        if (!active || generationRef.current !== requestGeneration) return;
        // Refresh insertion order so the fixed-size map behaves as an LRU for
        // history scrubbing instead of growing for the lifetime of the kiosk.
        cacheRef.current.delete(cacheKey);
        cacheRef.current.set(cacheKey, nextSenders);
        if (cacheRef.current.size > RECENT_SENDER_CACHE_LIMIT) {
          const oldestKey = cacheRef.current.keys().next().value;
          if (oldestKey !== undefined) cacheRef.current.delete(oldestKey);
        }
        setSenders(nextSenders);
      })
      .catch(() => {
        if (!active || generationRef.current !== requestGeneration) return;
        // No dedicated error chrome: a cached row remains useful during a
        // transient failure, while a first-load failure degrades to no byline.
        if (cachedSenders === undefined) setSenders(EMPTY_RECENT_SENDERS);
      })
      .finally(() => {
        if (!active || generationRef.current !== requestGeneration) return;
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
    // The stats object is intentionally a dependency: the provider replaces it
    // for every BoardStatsUpdated event, including edits and deletes where a
    // scalar such as lastSentAt may stay unchanged.
  }, [angle, boardId, client, climbUuid, enabled, stats]);

  return useMemo(() => ({ senders, isLoading }), [senders, isLoading]);
}
