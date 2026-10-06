// One version's generated wall looks, for the look picker.
//
// The render path reads the same query through `fetchSprayWallArt`; this is
// the screen's copy of it, polling only while a job is running so the picker
// can go from "Generating…" to the real thumbnails without a refresh.

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GET_SPRAY_WALL_ART } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallArt } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import { requestMissingSprayArt, sprayWallArtQueryKey } from './spray-wall-loader';

/**
 * How often a live wall's art is re-read while it is not ready yet. Light on
 * purpose: a render takes seconds, and the poll only runs while the picker is
 * on screen.
 */
export const SPRAY_ART_PENDING_POLL_MS = 10_000;

/** Reads after which an unready wall stops being polled (about five minutes). */
export const SPRAY_ART_MAX_POLLS = 30;

type SprayWallArtResponse = { sprayWallArt: SprayWallArt | null };

/**
 * `version` null reads the published version. `layoutId`, when given, is the
 * live wall: its art is polled while NONE or PENDING (reading it queues a job
 * for an old recipe), and the wall is swapped onto its new look the moment the
 * art turns READY. Without it (a draft, which gets art only when published)
 * nothing polls.
 */
export function useSprayWallArt(wallUuid: string | null, version: number | null, layoutId?: number) {
  const query = useQuery({
    queryKey: sprayWallArtQueryKey(wallUuid ?? '', version),
    queryFn: () => getHttpClient().request<SprayWallArtResponse>(GET_SPRAY_WALL_ART, { uuid: wallUuid, version }),
    enabled: wallUuid != null,
    select: (response) => response.sprayWallArt ?? null,
    // A backend without the query answers with a validation error. Asking again
    // will not change that, and the picker simply stays hidden.
    retry: false,
    refetchInterval: (current) => {
      // A backend whose art queue is off leaves a wall at NONE for good; stop
      // asking after a few minutes rather than for as long as the screen is up.
      if (layoutId == null || current.state.dataUpdateCount > SPRAY_ART_MAX_POLLS) return false;
      const status = current.state.data?.sprayWallArt?.status;
      return status === 'PENDING' || status === 'NONE' ? SPRAY_ART_PENDING_POLL_MS : false;
    },
    refetchOnWindowFocus: true,
  });

  const status = query.data?.status;
  const previousStatus = useRef(status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = status;
    if (layoutId != null && status === 'READY' && was !== 'READY' && was !== undefined) {
      requestMissingSprayArt(layoutId);
    }
  }, [status, layoutId]);

  return query;
}
