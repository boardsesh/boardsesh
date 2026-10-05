// Fetching one wall and putting it in the registry.
//
// Split from `spray-wall-registry.ts` because that module is read on the DRAW
// path — `board-details.ts`, `create-board-holds.ts`, both render-board
// resolvers — and a GraphQL client there would drag `expo-secure-store` and the
// whole auth chain into every one of their module graphs. The registry takes
// this as an injected function instead (`setSprayWallLoader`), so the render
// path can ASK for a wall without being able to reach the network itself.
//
// Two round trips, deliberately. `sprayWallRenderData` is keyed on the wall's
// uuid; a board config carries only a layout id. `sprayWallByLayout` turns one
// into the other, and it is a separate query so it can be cached hard: a wall's
// uuid never changes, while its render payload carries presigned photo URLs that
// expire in fifteen minutes and holds that change on every reset.

import { isCancelledError, type QueryClient } from '@tanstack/react-query';
import {
  GET_SPRAY_WALL,
  GET_SPRAY_WALL_BY_LAYOUT,
  GET_SPRAY_WALL_RENDER_DATA,
} from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWall, SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import {
  REGISTERED_WALL_REVALIDATE_MS,
  refreshSprayWall,
  settleSprayWallDiscoveryMiss,
  registerSprayWall,
  setSprayWallLoader,
  sprayVersionToken,
  unregisterSprayWall,
  sprayWallLoaderGeneration,
  unsetSprayWallLoader,
  subscribeToSprayWallWithdrawals,
} from './spray-wall-registry';
import { clearSupersededSprayDrafts } from '../create-climb-draft-store';
import { reportHandledError } from '../error-reporting';
import { mapCanonicalHoldsToPhoto, type CanonicalSprayHold } from './spray-hold-geometry';
import {
  sprayPrivacyGeneration,
  captureSprayPrivacyGenerations,
  sprayLinkPrivacyGeneration,
} from './spray-privacy-generation';

type SprayWallByLayoutResponse = { sprayWallByLayout: SprayWall | null };
type SprayWallRenderDataResponse = { sprayWallRenderData: SprayWallRenderData | null };

export const sprayWallByLayoutQueryKey = (layoutId: number | null) =>
  ['sprayWallByLayout', layoutId, sprayPrivacyGeneration(layoutId ?? undefined)] as const;
export const sprayWallRenderDataQueryKey = (wallUuid: string | null) =>
  ['sprayWallRenderData', wallUuid, sprayPrivacyGeneration()] as const;

const privateWallQueryFamilies = new Set([
  'sprayWallByLayout',
  'sprayWall',
  'sprayWallRenderData',
  'sprayWallWithVersions',
  'sprayWallResetProposal',
]);

function recordFields(payload: unknown): Record<string, unknown> | undefined {
  return payload != null && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
}

/** Remove every epoch of this wall, not merely the key new readers will use. */
function eraseWithdrawnWallQueries(queryClient: QueryClient, layoutId?: number, registeredUuid?: string): void {
  const queries = queryClient.getQueryCache().getAll();
  const wallUuids = new Set<string>(registeredUuid ? [registeredUuid] : []);
  const versionIds = new Set<string>();
  if (layoutId != null) {
    for (const query of queries) {
      if (!privateWallQueryFamilies.has(String(query.queryKey[0]))) continue;
      const response = recordFields(query.state.data);
      const render = recordFields(response?.sprayWallRenderData);
      const wall = recordFields(response?.sprayWallByLayout ?? response?.sprayWall ?? render?.wall ?? response);
      if (wall?.layoutId !== layoutId && !(query.queryKey[0] === 'sprayWallByLayout' && query.queryKey[1] === layoutId))
        continue;
      if (typeof wall?.uuid === 'string') wallUuids.add(wall.uuid);
    }
    for (const query of queries) {
      if (!privateWallQueryFamilies.has(String(query.queryKey[0]))) continue;
      const response = recordFields(query.state.data);
      const render = recordFields(response?.sprayWallRenderData);
      const wall = recordFields(response?.sprayWallByLayout ?? response?.sprayWall ?? render?.wall ?? response);
      const knownUuid = typeof query.queryKey[1] === 'string' && wallUuids.has(query.queryKey[1]);
      if (wall?.layoutId !== layoutId && !knownUuid) continue;
      const versions = Array.isArray(wall?.versions) ? wall.versions : [];
      for (const version of [...versions, wall?.currentVersion]) {
        const versionId = recordFields(version)?.id;
        if (typeof versionId === 'string') versionIds.add(versionId);
      }
    }
  }
  queryClient.removeQueries({
    predicate: (query) => {
      const [family, identity] = query.queryKey;
      if (!privateWallQueryFamilies.has(String(family))) return false;
      if (layoutId == null) return true;
      if (family === 'sprayWallByLayout') return identity === layoutId;
      if (family === 'sprayWallResetProposal') return typeof identity === 'string' && versionIds.has(identity);
      return typeof identity === 'string' && wallUuids.has(identity);
    },
  });
}

let unsubscribeQueryWithdrawal: (() => void) | undefined;

/**
 * A wall's uuid is immutable, so this is cached for the session and never
 * refetched on focus. A wall that is deleted resolves null on the next cold
 * start, which is when the board itself disappears from the roster anyway.
 */
export const WALL_IDENTITY_STALE_TIME_MS = 60 * 60 * 1000;

/**
 * How long the render payload stays fresh.
 *
 * Bounded by the photo signature, not by how often a wall changes: the URLs in
 * hand stop working after fifteen minutes, so ten leaves a margin for a surface
 * that was opened just before the boundary. A reset lands on the next refetch —
 * the version moves, every cache key moves with it (`sprayCacheToken`), and the
 * new photo downloads under its own name.
 *
 * The SAME number as the registry's revalidation gate, and taken from it rather
 * than re-declared: that gate decides whether the loader is asked, this one
 * decides whether asking costs a request, and two windows that drifted apart
 * would either re-request on every row or never re-request at all.
 */
export const RENDER_DATA_STALE_TIME_MS = REGISTERED_WALL_REVALIDATE_MS;

function toCanonicalHolds(renderData: SprayWallRenderData): CanonicalSprayHold[] {
  return renderData.holds.map((hold) => ({
    id: hold.id,
    cx: hold.cx,
    cy: hold.cy,
    r: hold.r,
    outline: hold.outline ?? null,
    // Not geometry, and nothing on the render path reads it — but the editor
    // does, and a hold seeded without it is re-submitted as MANUAL the first
    // time it is nudged (#5441).
    source: hold.source === 'AUTO' ? 'AUTO' : 'MANUAL',
    confidence: hold.confidence ?? null,
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

/**
 * Share of a wall's holds that may fail to map before it is worth reporting.
 *
 * Not zero. A projective map sends points beyond its horizon to infinity, and a
 * wall photographed hard off to one side can legitimately lose a hold or two at
 * the very edge — `mapCanonicalHoldsToPhoto` drops those on purpose so one bad
 * row costs one hold rather than the wall. What is NOT normal is a near-degenerate
 * homography taking a large slice of the wall with it: the board still renders, so
 * `Board Render Failed` never fires, and without this the only symptom is a
 * climber saying holds are missing.
 */
const DROPPED_HOLD_REPORT_FRACTION = 0.05;

/**
 * Report a wall that lost a material share of its holds to the mapping.
 *
 * Sentry, not an analytics event: `docs/board-render-analytics.md` keeps the
 * board-render event set deliberately small, and this is a defect signal with a
 * stack and a wall to look at rather than a behavioural one worth a per-render
 * PostHog row.
 */
function reportDroppedHolds(renderData: SprayWallRenderData, expected: number, mapped: number): void {
  const dropped = expected - mapped;
  if (dropped <= 0 || expected === 0) return;
  if (dropped < expected * DROPPED_HOLD_REPORT_FRACTION) return;

  reportHandledError(new Error(`spray wall dropped ${dropped} of ${expected} holds while mapping into its photo`), {
    level: 'warning',
    tags: { boardName: 'spray' },
    extra: {
      wallUuid: renderData.wall.uuid,
      versionNumber: renderData.versionNumber,
      expectedHolds: expected,
      mappedHolds: mapped,
    },
  });
}

/** Put one wall's published version in the registry, mapped into its photo's pixels. */
export function registerRenderData(layoutId: number, renderData: SprayWallRenderData): boolean {
  const dimensions = photoDimensions(renderData);
  const canonicalHolds = toCanonicalHolds(renderData);
  const holds = mapCanonicalHoldsToPhoto(renderData.homography, canonicalHolds);
  // A wall we cannot map is a wall we must not draw: registering it with unmapped
  // holds would paint every one at its canonical coordinate on top of a
  // photograph it does not belong to — plausible-looking and wrong.
  if (!holds || !dimensions) return false;

  reportDroppedHolds(renderData, canonicalHolds.length, holds.length);

  registerSprayWall(layoutId, {
    wallUuid: renderData.wall.uuid,
    // The wall's own angle, not the caller's. Every climb set on the wall has to
    // carry it or the server refuses the write. Optional-chained because
    // `SprayWall.board` is only non-null by schema contract — see the field's note
    // on `RegisteredSprayWall` for why a missing angle registers anyway.
    angle: renderData.wall.board?.angle ?? null,
    version: renderData.versionNumber,
    photoWidth: dimensions.width,
    photoHeight: dimensions.height,
    photoUrl: renderData.photo.url,
    photoThumbUrl: renderData.photo.thumbUrl ?? null,
    photoExpiresAt: renderData.photo.expiresAt,
    holds,
  });

  // The create-climb draft slot is keyed on the version, so a reset moves it and
  // leaves the old one holding holds that are no longer on the wall. Nothing else
  // would ever read or remove it. Fire-and-forget: losing this costs a few
  // kilobytes, and it must not sit in front of the first paint.
  void clearSupersededSprayDrafts(layoutId, sprayVersionToken('spray', layoutId)).catch(() => {
    // AsyncStorage unavailable. The orphan survives until the next reset.
  });
  return true;
}

/** The wall's uuid for a layout id, through React Query so two callers share one request. */
export function fetchSprayWallUuid(queryClient: QueryClient, layoutId: number): Promise<string | null> {
  return queryClient
    .fetchQuery({
      queryKey: sprayWallByLayoutQueryKey(layoutId),
      queryFn: () => getHttpClient().request<SprayWallByLayoutResponse>(GET_SPRAY_WALL_BY_LAYOUT, { layoutId }),
      staleTime: WALL_IDENTITY_STALE_TIME_MS,
    })
    .then((response) => response.sprayWallByLayout?.uuid ?? null);
}

/** The render payload for a wall uuid, through the same shared cache. */
export function fetchSprayWallRenderData(
  queryClient: QueryClient,
  wallUuid: string,
): Promise<SprayWallRenderData | null> {
  return queryClient
    .fetchQuery({
      queryKey: sprayWallRenderDataQueryKey(wallUuid),
      queryFn: () =>
        getHttpClient().request<SprayWallRenderDataResponse>(GET_SPRAY_WALL_RENDER_DATA, { uuid: wallUuid }),
      staleTime: RENDER_DATA_STALE_TIME_MS,
    })
    .then((response) => response.sprayWallRenderData ?? null);
}

/**
 * Fetch one wall and register it.
 *
 * Rejects on a transport failure so the registry marks the wall unavailable and
 * retries after its cooldown; resolves without registering when the wall is
 * genuinely not there (deleted, invisible, nothing published), which is the same
 * outcome from a surface's point of view but not worth retrying against.
 */
export async function loadSprayWall(
  queryClient: QueryClient,
  layoutId: number,
  options?: { force?: boolean },
): Promise<void> {
  const generation = sprayPrivacyGeneration(layoutId);
  const loaderEpoch = sprayWallLoaderGeneration();
  const isCurrent = () =>
    generation === sprayPrivacyGeneration(layoutId) && loaderEpoch === sprayWallLoaderGeneration();
  const wallUuid = await fetchSprayWallUuid(queryClient, layoutId).catch((error: unknown) => {
    if (!isCurrent()) return null;
    throw error;
  });
  if (!isCurrent()) return;
  if (!wallUuid) {
    settleSprayWallDiscoveryMiss(layoutId);
    return;
  }

  // A forced load is one whose CACHED payload is known to be useless — the photo
  // signature in it has expired — so the stale window has to be dropped or
  // `fetchQuery` hands the dead URL straight back.
  if (options?.force) {
    await queryClient.invalidateQueries({ queryKey: sprayWallRenderDataQueryKey(wallUuid) });
    if (!isCurrent()) return;
  }

  const renderData = await fetchSprayWallRenderData(queryClient, wallUuid).catch((error: unknown) => {
    if (!isCurrent()) return null;
    throw error;
  });
  if (!isCurrent()) return;
  if (!renderData) {
    // The wall exists but has nothing renderable: deleted between the two reads,
    // visibility revoked, the published version's photo gone. A wall we already
    // hold must be WITHDRAWN here rather than left drawing its old holds over a
    // cached photo indefinitely — the `!wallUuid` branch above withdraws for the
    // same reason, and a revalidation is exactly when this branch is reached with
    // a live registration in place.
    unregisterSprayWall(layoutId);
    return;
  }
  registerRenderData(layoutId, renderData);
}

/**
 * Re-register a wall immediately after THIS device changed it.
 *
 * The revalidation gate closes the cross-device hole (another climber publishes
 * a reset; this session picks it up within the stale window), but the device that
 * published should not wait on a window at all — it already knows the version
 * moved. `publishSprayWallVersion` and, once SW-12 lands it,
 * `commitSprayWallVersion` call this on success: the cached payload is dropped
 * and the wall re-registers under its new version, which moves every spray cache
 * key with it.
 *
 * SW-08's editor calls it on unmount, to put the published generation back for
 * whatever outlives the screen (`use-spray-wall-draft.ts`). SW-12's
 * `commitSprayWallVersion` is the other caller, once it lands.
 */
export async function invalidateSprayWallRenderData(
  queryClient: QueryClient,
  wallUuid: string,
  layoutId: number,
): Promise<void> {
  const generation = sprayPrivacyGeneration(layoutId);
  const loaderEpoch = sprayWallLoaderGeneration();
  await queryClient.invalidateQueries({ queryKey: sprayWallRenderDataQueryKey(wallUuid) });
  if (generation !== sprayPrivacyGeneration(layoutId) || loaderEpoch !== sprayWallLoaderGeneration()) return;
  refreshSprayWall(layoutId);
}

/**
 * Wire `ensureSprayWallLoaded` up to the network. Returns the teardown.
 *
 * Called once, from the app-wide provider that owns the query client. Every
 * spray surface below it — including ones that never see a hook, like the
 * per-row render-board resolvers — can then ask for a wall by layout id.
 */
export function installSprayWallLoader(queryClient: QueryClient): () => void {
  unsubscribeQueryWithdrawal?.();
  const unsubscribeWithdrawal = subscribeToSprayWallWithdrawals((layoutId, wallUuid) => {
    eraseWithdrawnWallQueries(queryClient, layoutId, wallUuid);
  });
  unsubscribeQueryWithdrawal = unsubscribeWithdrawal;
  let active = true;
  const loader = (layoutId: number, options?: { force?: boolean }) =>
    active ? loadSprayWall(queryClient, layoutId, options) : Promise.resolve();
  setSprayWallLoader(loader);
  return () => {
    active = false;
    unsubscribeWithdrawal();
    if (unsubscribeQueryWithdrawal === unsubscribeWithdrawal) unsubscribeQueryWithdrawal = undefined;
    unsetSprayWallLoader(loader);
  };
}

type SprayWallResponse = { sprayWall: SprayWall | null };

/**
 * Take up the capability in a share link: resolve one wall BY UUID and seed the
 * by-layout cache with it.
 *
 * This is the whole reason an unlisted share link carries `?wall=<uuid>`.
 * `sprayWallByLayout` refuses an unlisted wall to anyone who is not its owner or
 * a member of its gym — a layout id is a sequence number, so answering there
 * would make every unlisted wall enumerable — while `sprayWall(uuid)` resolves
 * it, because holding the uuid IS the proof you were handed the link.
 *
 * So the link's recipient asks the question they can answer, and the answer is
 * written into `sprayWallByLayoutQueryKey(layoutId)`. Every later reader —
 * `fetchSprayWallUuid`, and through it the whole render path — then finds the
 * wall in cache and never asks the query that would refuse it.
 *
 * Seeding is not enough on its own, and that was a real bug: the handoff that
 * navigates to the board runs CONCURRENTLY with this, so `ensureSprayWallLoaded`
 * can get there first. On an unlisted wall it then resolves `sprayWallByLayout`
 * to null — correctly, the recipient is not a member — which caches null for an
 * hour, marks the wall `unavailable` in the registry and starts a 30-second retry
 * cooldown. Writing the right answer into the cache afterwards fixes nothing by
 * itself: nothing asks again, so a climber holding a perfectly good link lands on
 * a blank placeholder. So adoption ENDS by forcing a registration, which skips
 * both the cooldown and the stale window and now finds the seeded wall in cache.
 * Whichever of the two got there first, the wall ends up registered.
 *
 * Returns the wall's layout id, or `null` when it does not resolve (deleted, a
 * bad uuid, or a private wall the viewer may not see), in which case nothing is
 * written.
 */
export async function adoptSprayWallFromLink(queryClient: QueryClient, wallUuid: string): Promise<number | null> {
  const generation = sprayPrivacyGeneration();
  const wallGeneration = captureSprayPrivacyGenerations();
  const loaderEpoch = sprayWallLoaderGeneration();
  const queryKey = ['sprayWall', wallUuid, sprayLinkPrivacyGeneration()] as const;
  const response = await queryClient
    .fetchQuery({
      queryKey,
      queryFn: () => getHttpClient().request<SprayWallResponse>(GET_SPRAY_WALL, { uuid: wallUuid }),
      staleTime: WALL_IDENTITY_STALE_TIME_MS,
    })
    .catch((error: unknown) => {
      if (generation !== sprayPrivacyGeneration() || loaderEpoch !== sprayWallLoaderGeneration()) return null;
      if (isCancelledError(error) && queryKey[2] !== sprayLinkPrivacyGeneration()) return null;
      throw error;
    });

  const wall = response?.sprayWall;
  // Session/loader guards cover sign-out and teardown; the returned layout's
  // snapshot below covers an explicit single-wall withdrawal during discovery.
  if (generation !== sprayPrivacyGeneration() || loaderEpoch !== sprayWallLoaderGeneration()) {
    queryClient.removeQueries({ queryKey, exact: true });
    return null;
  }
  if (!wall) return null;
  if (wallGeneration(wall.layoutId) !== sprayPrivacyGeneration(wall.layoutId)) {
    queryClient.removeQueries({ queryKey, exact: true });
    return null;
  }

  queryClient.setQueryData(sprayWallByLayoutQueryKey(wall.layoutId), { sprayWallByLayout: wall });
  refreshSprayWall(wall.layoutId);
  return wall.layoutId;
}
