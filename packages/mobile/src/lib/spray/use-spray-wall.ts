// `useSprayWall(layoutId)` — the one thing that puts a wall in the registry.
//
// Two round trips, deliberately. `sprayWallRenderData` is keyed on the wall's
// uuid; a board config carries only a layout id. `sprayWallByLayout` turns one
// into the other, and it is a separate query so it can be cached hard: a wall's
// uuid never changes, while its render payload carries presigned photo URLs that
// expire in fifteen minutes and holds that change on every reset.
//
// The photo URLs are the reason nothing here is persisted. `SprayWallPhoto.url`
// is a signature over an object in the PRIVATE bucket (`docs/spray-walls.md`,
// "Photos and privacy"), so the query refetches rather than storing it, and the
// local copy on disk is keyed on `(layoutId, version)` instead — see
// `spray-photo-cache.ts`.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GET_SPRAY_WALL_BY_LAYOUT, GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWall, SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import { registerSprayWall, unregisterSprayWall } from './spray-wall-registry';
import { mapCanonicalHoldsToPhoto, type CanonicalSprayHold } from './spray-hold-geometry';

type SprayWallByLayoutResponse = { sprayWallByLayout: SprayWall | null };
type SprayWallRenderDataResponse = { sprayWallRenderData: SprayWallRenderData | null };

export const sprayWallByLayoutQueryKey = (layoutId: number | null) => ['sprayWallByLayout', layoutId] as const;
export const sprayWallRenderDataQueryKey = (wallUuid: string | null) => ['sprayWallRenderData', wallUuid] as const;

/**
 * A wall's uuid is immutable, so this is cached for the session and never
 * refetched on focus. A wall that is deleted resolves null on the next cold
 * start, which is when the board itself disappears from the roster anyway.
 */
const WALL_IDENTITY_STALE_TIME_MS = 60 * 60 * 1000;

/**
 * How long the render payload stays fresh.
 *
 * Bounded by the photo signature, not by how often a wall changes: the URLs in
 * hand stop working after fifteen minutes, so ten leaves a margin for a surface
 * that was opened just before the boundary. A reset lands on the next refetch —
 * the version moves, every cache key moves with it (`sprayCacheToken`), and the
 * new photo downloads under its own name.
 */
const RENDER_DATA_STALE_TIME_MS = 10 * 60 * 1000;

function toCanonicalHolds(renderData: SprayWallRenderData): CanonicalSprayHold[] {
  return renderData.holds.map((hold) => ({
    id: hold.id,
    cx: hold.cx,
    cy: hold.cy,
    r: hold.r,
    outline: hold.outline ?? null,
  }));
}

/**
 * The photo's own pixel size, or `null`.
 *
 * `SprayWallPhoto.width` / `height` are nullable — they come off the stored
 * object's metadata, and a row written by hand may have neither. There is no
 * fallback, and the canonical frame is specifically NOT one: holds were mapped
 * into PHOTO pixels, so drawing them against a frame of a different aspect does
 * not stretch the picture, it slides every hold off the hold it belongs to. A
 * wall whose photo will not say how big it is cannot be drawn, and the render
 * path's placeholder is the honest answer.
 */
function photoDimensions(renderData: SprayWallRenderData): { width: number; height: number } | null {
  const { width, height } = renderData.photo;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

export type UseSprayWallResult = {
  /** True while either query is in flight and nothing is registered yet. */
  isLoading: boolean;
  /**
   * The wall resolved but cannot be drawn: no published version or no readable
   * photo (the query answers null), a photo that will not say its pixel size, or
   * a singular homography. The board surface shows its placeholder either way;
   * this is the flag a screen would read to say so in words.
   */
  isUnrenderable: boolean;
};

/**
 * Fetch one wall and keep the registry pointed at its published version.
 *
 * Call it from the surface that owns the board config (`useSprayWall(layoutId)`);
 * every downstream reader — `getBoardRenderData`, `getCreateBoardHolds`, the
 * background cache, `use-native-climb-render` — then finds the wall synchronously
 * with no prop-drilling and no branch of its own.
 *
 * `layoutId: null` disables both queries, so a surface can call this
 * unconditionally while its board config resolves.
 */
export function useSprayWall(layoutId: number | null): UseSprayWallResult {
  const identity = useQuery({
    queryKey: sprayWallByLayoutQueryKey(layoutId),
    queryFn: () => getHttpClient().request<SprayWallByLayoutResponse>(GET_SPRAY_WALL_BY_LAYOUT, { layoutId }),
    select: (response) => response.sprayWallByLayout,
    enabled: layoutId != null,
    staleTime: WALL_IDENTITY_STALE_TIME_MS,
  });

  const wallUuid = identity.data?.uuid ?? null;

  const render = useQuery({
    queryKey: sprayWallRenderDataQueryKey(wallUuid),
    queryFn: () => getHttpClient().request<SprayWallRenderDataResponse>(GET_SPRAY_WALL_RENDER_DATA, { uuid: wallUuid }),
    select: (response) => response.sprayWallRenderData,
    enabled: wallUuid != null,
    staleTime: RENDER_DATA_STALE_TIME_MS,
  });

  const renderData = render.data ?? null;

  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    if (layoutId == null || !renderData) return;

    const dimensions = photoDimensions(renderData);
    const holds = mapCanonicalHoldsToPhoto(renderData.homography, toCanonicalHolds(renderData));
    // A wall we cannot map is a wall we must not draw: registering it with
    // unmapped holds would paint every one at its canonical coordinate on top of
    // a photograph it does not belong to — plausible-looking and wrong.
    if (!holds || !dimensions) {
      setRegistered(false);
      return;
    }

    registerSprayWall(layoutId, {
      wallUuid: renderData.wall.uuid,
      version: renderData.versionNumber,
      photoWidth: dimensions.width,
      photoHeight: dimensions.height,
      photoUrl: renderData.photo.url,
      photoThumbUrl: renderData.photo.thumbUrl ?? null,
      photoExpiresAt: renderData.photo.expiresAt,
      holds,
    });
    setRegistered(true);
    // Deliberately NOT unregistered on unmount. The registry is session state, not
    // screen state: a queue thumbnail, a play drawer and a list row all draw the
    // same wall from it, and tearing it down when one of them unmounts would blank
    // the others. It is withdrawn when the wall itself goes away.
  }, [layoutId, renderData]);

  useEffect(() => {
    // The wall is gone (deleted, or no longer visible to this viewer). Withdraw
    // it so the render path reports no board rather than serving the last photo
    // it happened to see.
    if (layoutId == null || identity.isPending || identity.data !== null) return;
    unregisterSprayWall(layoutId);
  }, [layoutId, identity.isPending, identity.data]);

  const isLoading = identity.isPending || (wallUuid != null && render.isPending);
  return {
    isLoading,
    // The wall is there and the fetch is done, but nothing made it into the
    // registry — which covers a null payload (no published version, no readable
    // photo) and a payload we could not map, the two being indistinguishable to
    // a surface that just needs to know whether to draw the placeholder.
    isUnrenderable: !isLoading && identity.data != null && !registered,
  };
}
