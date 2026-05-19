'use client';

import { useContext, useEffect, useState } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import type { BoardName } from '@/app/lib/types';

/**
 * Per-(boardName, climbUuid, angle) cache that holds two pieces of state:
 *
 *   - `ascentDelta` is set by the tick mutation while the recompute is in
 *     flight. It is +1 when the user just made their first send/flash at
 *     this (climb, angle), 0 otherwise. Cleared on error rollback or once
 *     the live event arrives with the canonical numbers.
 *   - `live` is the latest `ClimbStatsEvent` payload pushed from the
 *     backend after the debounced recompute finishes. When present it
 *     overrides any optimistic delta.
 *
 * Consumers read this state via {@link useEffectiveClimbStats}.
 */
export type ClimbStatsLive = {
  ascentDelta: number;
  live: ClimbStatsLivePayload | null;
};

export type ClimbStatsLivePayload = {
  ascensionistCount: number;
  qualityAverage: number | null;
  difficultyAverage: number | null;
  displayDifficulty: number | null;
};

const EMPTY_LIVE: ClimbStatsLive = { ascentDelta: 0, live: null };

export function climbStatsLiveKey(boardName: BoardName, climbUuid: string, angle: number) {
  return ['climbStatsLive', boardName, climbUuid, angle] as const;
}

/**
 * Read the climb-stats cache directly off the QueryClient and re-render
 * when it changes. Uses `QueryClientContext` rather than `useQueryClient`
 * so test environments that don't set up a `QueryClientProvider` get a
 * silent `EMPTY_LIVE` instead of a render-time throw — important because
 * `ClimbTitle` is exercised by several unit tests that don't otherwise
 * need React Query.
 */
export function useClimbStatsLive(
  boardName: BoardName | undefined,
  climbUuid: string | undefined,
  angle: number | undefined,
): ClimbStatsLive {
  const client = useContext(QueryClientContext);
  const [snapshot, setSnapshot] = useState<ClimbStatsLive>(EMPTY_LIVE);

  useEffect(() => {
    if (!client || !boardName || !climbUuid || typeof angle !== 'number') {
      setSnapshot(EMPTY_LIVE);
      return;
    }
    const key = climbStatsLiveKey(boardName, climbUuid, angle);
    const cache = client.getQueryCache();
    setSnapshot(client.getQueryData<ClimbStatsLive>(key) ?? EMPTY_LIVE);
    // Subscribe to all cache events and filter by query hash — this is the
    // public API React Query exposes for "watch this key without driving a
    // useQuery instance". We use it because the live-stats cache is purely
    // writer-driven (no queryFn), so a standard useQuery would create an
    // idle query entry just to read.
    const targetHash = JSON.stringify(key);
    const unsub = cache.subscribe((event) => {
      if (event?.query?.queryHash === targetHash) {
        setSnapshot(client.getQueryData<ClimbStatsLive>(key) ?? EMPTY_LIVE);
      }
    });
    return unsub;
  }, [client, boardName, climbUuid, angle]);

  return snapshot;
}

export type EffectiveClimbStats = {
  ascensionistCount: number;
  qualityAverage: string | null;
  difficulty: string | null;
};

/**
 * Resolve the displayed values for a climb's stats. Live event wins over
 * optimistic delta; both fall back to the prop-supplied base values when
 * neither has fired (or when the caller didn't pass enough to identify
 * the climb, e.g. legacy callers without `boardName`/`uuid`).
 */
export function useEffectiveClimbStats(
  boardName: BoardName | undefined,
  climbUuid: string | undefined,
  angle: number | undefined,
  base: {
    ascensionist_count?: number;
    quality_average?: string | null;
    difficulty?: string | null;
  },
): EffectiveClimbStats {
  const state = useClimbStatsLive(boardName, climbUuid, angle);

  if (!boardName || !climbUuid || typeof angle !== 'number') {
    return {
      ascensionistCount: base.ascensionist_count ?? 0,
      qualityAverage: base.quality_average ?? null,
      difficulty: base.difficulty ?? null,
    };
  }

  if (state.live) {
    return {
      ascensionistCount: state.live.ascensionistCount,
      qualityAverage: state.live.qualityAverage == null ? null : String(state.live.qualityAverage),
      difficulty:
        state.live.displayDifficulty == null ? (base.difficulty ?? null) : String(state.live.displayDifficulty),
    };
  }

  return {
    ascensionistCount: (base.ascensionist_count ?? 0) + state.ascentDelta,
    qualityAverage: base.quality_average ?? null,
    difficulty: base.difficulty ?? null,
  };
}

// ============================================
// Imperative writers (used by mutations + the subscription bridge)
// ============================================

function setState(
  queryClient: QueryClient,
  boardName: BoardName,
  climbUuid: string,
  angle: number,
  updater: (prev: ClimbStatsLive) => ClimbStatsLive,
) {
  queryClient.setQueryData<ClimbStatsLive>(climbStatsLiveKey(boardName, climbUuid, angle), (prev) =>
    updater(prev ?? EMPTY_LIVE),
  );
}

export function bumpAscentDelta(
  queryClient: QueryClient,
  boardName: BoardName,
  climbUuid: string,
  angle: number,
  by: number,
) {
  setState(queryClient, boardName, climbUuid, angle, (prev) => ({
    ...prev,
    ascentDelta: prev.ascentDelta + by,
  }));
}

export function setLiveClimbStats(
  queryClient: QueryClient,
  boardName: BoardName,
  climbUuid: string,
  angle: number,
  payload: ClimbStatsLivePayload,
) {
  // Live values supersede the optimistic delta — zero it out on every
  // arrival so a stale delta doesn't double-count when added to the
  // canonical numbers later (it won't, because `useEffectiveClimbStats`
  // prefers `live` when present, but defensively reset it anyway).
  setState(queryClient, boardName, climbUuid, angle, () => ({
    ascentDelta: 0,
    live: payload,
  }));
}

export function clearClimbStatsLive(queryClient: QueryClient, boardName: BoardName, climbUuid: string, angle: number) {
  queryClient.setQueryData<ClimbStatsLive>(climbStatsLiveKey(boardName, climbUuid, angle), EMPTY_LIVE);
}
