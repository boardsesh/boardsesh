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

import { useEffect } from 'react';
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
 * The photo's own pixel size, falling back to the canonical frame.
 *
 * `SprayWallPhoto.width` / `height` are nullable — they come off the stored
 * object's metadata, and a row written by hand may have neither. The canonical
 * frame is the honest fallback for a wall whose photo IS its frame (the identity
 * homography case, which is every wall created without anchors), and it is the
 * right shape even when it is not exactly the photo's: a wrong aspect stretches
 * the picture, whereas a zero would make the render path report no board at all.
 */
function photoDimensions(renderData: SprayWallRenderData): { width: number; height: number } {
  return {
    width: renderData.photo.width ?? renderData.boardWidth,
    height: renderData.photo.height ?? renderData.boardHeight,
  };
}

export type UseSprayWallResult = {
  /** True while either query is in flight and nothing is registered yet. */
  isLoading: boolean;
  /**
   * The wall exists and is visible but cannot be drawn — a singular homography,
   * or a photo with no usable dimensions. The board surface shows its placeholder.
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

  useEffect(() => {
    if (layoutId == null || !renderData) return;

    const { width, height } = photoDimensions(renderData);
    const holds = mapCanonicalHoldsToPhoto(renderData.homography, toCanonicalHolds(renderData));
    // A wall we cannot map is a wall we must not draw: registering it with
    // unmapped holds would paint every one at its canonical coordinate on top of
    // a photograph it does not belong to — plausible-looking and wrong.
    if (!holds || !(width > 0) || !(height > 0)) return;

    registerSprayWall(layoutId, {
      wallUuid: renderData.wall.uuid,
      version: renderData.versionNumber,
      photoWidth: width,
      photoHeight: height,
      photoUrl: renderData.photo.url,
      photoThumbUrl: renderData.photo.thumbUrl ?? null,
      photoExpiresAt: renderData.photo.expiresAt,
      holds,
    });
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
    isUnrenderable: !isLoading && identity.data != null && renderData == null && !render.isPending,
  };
}
