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

import { getConnectivitySnapshot, subscribeConnectivity } from '../connectivity/connectivity-store';
import { isNetworkError } from '@boardsesh/offline-sync/error-classification';
import type { QueryClient } from '@tanstack/react-query';
import {
  GET_SPRAY_WALL_BY_LAYOUT,
  GET_SPRAY_WALL_LOOK,
  GET_SPRAY_WALL_RENDER_DATA,
} from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWall, SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import {
  REGISTERED_WALL_REVALIDATE_MS,
  refreshSprayWall,
  settleSprayWallDiscoveryMiss,
  registerSprayWall,
  resetSprayWallViewerAccess,
  setSprayWallLoader,
  setSprayWallLook,
  sprayVersionToken,
  sprayWallViewerGeneration,
  unregisterSprayWall,
  sprayWallRemovalGeneration,
  subscribeToSprayWalls,
  type SprayWallArchiveState,
  type SprayWallRenderSettingsValue,
  sprayWallLoaderGeneration,
  unsetSprayWallLoader,
  subscribeToSprayWallWithdrawals,
} from './spray-wall-registry';
import { clearSupersededSprayDrafts } from '../create-climb-draft-store';
import { rememberSprayWallArchive } from '../../settings/offline-boards';
import { sanitizeBoardRenderDefault } from '../board-render-settings';
import { reportHandledError } from '../error-reporting';
import { mapCanonicalHoldsToPhoto, type CanonicalSprayHold } from './spray-hold-geometry';
import { sprayPrivacyGeneration } from './spray-privacy-generation';

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
  'sprayWallRevisionRenderData',
  'sprayWallWithVersions',
]);

function recordFields(payload: unknown): Record<string, unknown> | undefined {
  return payload != null && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
}

/** Remove every epoch of this wall, not merely the key new readers will use. */
function eraseWithdrawnWallQueries(queryClient: QueryClient, layoutId?: number, registeredUuid?: string): void {
  const queries = queryClient.getQueryCache().getAll();
  const wallUuids = new Set<string>(registeredUuid ? [registeredUuid] : []);
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
  }
  queryClient.removeQueries({
    predicate: (query) => {
      const [family, identity] = query.queryKey;
      if (!privateWallQueryFamilies.has(String(family))) return false;
      if (layoutId == null) return true;
      if (family === 'sprayWallByLayout') return identity === layoutId;
      return typeof identity === 'string' && wallUuids.has(identity);
    },
  });
}

let unsubscribeQueryWithdrawal: (() => void) | undefined;

/**
 * The key the PUBLISHED render payload is cached under: the prefix above, plus
 * the viewer generation it was fetched under.
 *
 * The viewer generation is wrapped in an object, never a bare number. The hold
 * editor caches a DRAFT version under `['sprayWallRenderData', wallUuid,
 * versionNumber]` (`sprayWallDraftQueryKey`), and a viewer generation is a small
 * integer too: as a bare number in the same slot, generation 1 and draft
 * version 1 would be one cache entry with two different query functions, each
 * overwriting the other's payload. An object can never equal a number.
 *
 * The prefix above is NOT shared with the draft key any more. Since it gained
 * the privacy-generation segment (a string), its third segment can never equal
 * a draft's version number, so `invalidateSprayWallRenderData`, which
 * invalidates by that prefix, reaches published payloads only. Only the
 * two-segment `['sprayWallRenderData', wallUuid]` matches both kinds.
 */
export const sprayWallPublishedRenderDataQueryKey = (wallUuid: string, viewerGeneration: number) =>
  [...sprayWallRenderDataQueryKey(wallUuid), { viewerGeneration }] as const;

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

export function toCanonicalHolds(renderData: Pick<SprayWallRenderData, 'holds'>): CanonicalSprayHold[] {
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
    // The reset review's move link, for the create editor's lost-hold swap (#5493).
    ...(hold.movedFromHoldId != null ? { movedFromHoldId: hold.movedFromHoldId } : {}),
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
export function photoDimensions(
  renderData: Pick<SprayWallRenderData, 'photo'>,
): { width: number; height: number } | null {
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

/**
 * The wall's archive and hold-lock state, off its payload.
 *
 * A backend or a cached payload without the fields reads as a live wall with
 * free holds. An archived wall reads as locked whatever `holdsLocked` says, the
 * same rule the server applies.
 */
export function sprayWallArchiveStateOf(
  wall: Pick<SprayWall, 'archivedAt' | 'resetOfWallUuid' | 'replacedByWallUuid' | 'holdsLocked'>,
): SprayWallArchiveState {
  const archivedAt = wall.archivedAt ?? null;
  return {
    archivedAt,
    resetOfWallUuid: wall.resetOfWallUuid ?? null,
    replacedByWallUuid: wall.replacedByWallUuid ?? null,
    holdsLocked: wall.holdsLocked === true || archivedAt != null,
  };
}

/** Map one payload without replacing the published wall or its runtime geometry. */
export function mapSprayWallRenderData(
  layoutId: number,
  renderData: SprayWallRenderData,
  versionId: number,
  receivedAtMs: number,
) {
  const dimensions = photoDimensions(renderData);
  const canonicalHolds = toCanonicalHolds(renderData);
  const holds = mapCanonicalHoldsToPhoto(renderData.homography, canonicalHolds);
  if (!holds || !dimensions || !Number.isSafeInteger(versionId) || versionId <= 0) return null;
  return {
    layoutId,
    wallUuid: renderData.wall.uuid,
    angle: renderData.wall.board?.angle ?? null,
    version: renderData.versionNumber,
    versionId,
    photoWidth: dimensions.width,
    photoHeight: dimensions.height,
    photoUrl: renderData.photo.url,
    photoThumbUrl: renderData.photo.thumbUrl ?? null,
    photoExpiresAt: renderData.photo.expiresAt,
    holds,
    homography: renderData.homography,
    renderSettings: null,
    viewerCanEdit: renderData.wall.viewerCanEdit === true,
    viewerCanEditClimbs: (renderData.wall.viewerCanEditClimbs ?? renderData.wall.viewerCanEdit) === true,
    archive: sprayWallArchiveStateOf(renderData.wall),
    registeredAtMs: receivedAtMs,
  };
}

/**
 * Put one wall's published version in the registry, mapped into its photo's pixels.
 *
 * `look` is the wall's stored look when the caller already has it (`loadSprayWall`
 * reads it alongside the render data), so the wall registers drawn the right way
 * once. Left out, the wall registers keeping whatever look it already had and the
 * look is read in the background.
 */
export function registerRenderData(
  layoutId: number,
  renderData: SprayWallRenderData,
  look?: SprayWallRenderSettingsValue | null,
  // The viewer generation `renderData` was fetched under, read before the
  // request went out. Left out, the wall registers as "viewer cannot edit": a
  // caller that cannot say whose answer this is does not get to show Edit.
  fetchedUnderViewerGeneration?: number,
  fetchedUnderRemovalGeneration?: number,
): boolean {
  if (
    fetchedUnderRemovalGeneration !== undefined &&
    sprayWallRemovalGeneration(layoutId) !== fetchedUnderRemovalGeneration
  )
    return false;
  const currentVersion = renderData.wall.currentVersion;
  if (!currentVersion || currentVersion.number !== renderData.versionNumber) return false;
  const versionId = Number(currentVersion.id);
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return false;
  const dimensions = photoDimensions(renderData);
  const canonicalHolds = toCanonicalHolds(renderData);
  const holds = mapCanonicalHoldsToPhoto(renderData.homography, canonicalHolds);
  // A wall we cannot map is a wall we must not draw: registering it with unmapped
  // holds would paint every one at its canonical coordinate on top of a
  // photograph it does not belong to — plausible-looking and wrong.
  if (!holds || !dimensions) return false;

  reportDroppedHolds(renderData, canonicalHolds.length, holds.length);

  const archive = sprayWallArchiveStateOf(renderData.wall);
  registerSprayWall(layoutId, {
    wallUuid: renderData.wall.uuid,
    // The wall's own angle, not the caller's. Every climb set on the wall has to
    // carry it or the server refuses the write. Optional-chained because
    // `SprayWall.board` is only non-null by schema contract — see the field's note
    // on `RegisteredSprayWall` for why a missing angle registers anyway.
    angle: renderData.wall.board?.angle ?? null,
    // Only with a slug: `/b/{slug}` is the whole link, so a board row without
    // one shares no link at all rather than a broken one. And never for a wall an
    // admin hid: hidden means exactly what private means, and the server 404s the
    // page and the card for it (`hiddenAt` is only ever set for the owner).
    share:
      renderData.wall.board?.slug && !renderData.wall.hiddenAt
        ? {
            slug: renderData.wall.board.slug,
            isPublic: renderData.wall.board.isPublic,
            isUnlisted: renderData.wall.board.isUnlisted,
          }
        : null,
    version: renderData.versionNumber,
    versionId,
    photoWidth: dimensions.width,
    photoHeight: dimensions.height,
    photoUrl: renderData.photo.url,
    photoThumbUrl: renderData.photo.thumbUrl ?? null,
    photoExpiresAt: renderData.photo.expiresAt,
    holds,
    homography: renderData.homography,
    renderSettings: look,
    archive,
    // Strictly `true`: a payload from a backend that predates the field, or a
    // cached one missing it, must read as "cannot edit".
    viewerAccess:
      fetchedUnderViewerGeneration === undefined
        ? undefined
        : {
            canEdit: renderData.wall.viewerCanEdit === true,
            canEditClimbs: (renderData.wall.viewerCanEditClimbs ?? renderData.wall.viewerCanEdit) === true,
            generation: fetchedUnderViewerGeneration,
          },
  });
  if (look === undefined) void loadSprayWallLook(layoutId, renderData.wall.uuid);

  // Kept for the offline loader: SQLite has no column for either fact, so a
  // downloaded wall opened with no signal reads them from here.
  try {
    rememberSprayWallArchive(renderData.wall.uuid, archive);
  } catch (error) {
    reportHandledError(error, { level: 'warning', tags: { boardName: 'spray' } });
  }

  // The create-climb draft slot is keyed on the version, so a reset moves it and
  // leaves the old one holding holds that are no longer on the wall. Nothing else
  // would ever read or remove it. Fire-and-forget: losing this costs a few
  // kilobytes, and it must not sit in front of the first paint.
  void clearSupersededSprayDrafts(layoutId, sprayVersionToken('spray', layoutId)).catch(() => {
    // AsyncStorage unavailable. The orphan survives until the next reset.
  });
  return true;
}

type SprayWallLookResponse = { sprayWall: { uuid: string; renderSettings?: unknown } | null } | undefined;

/**
 * How long a FAILED look read stands before the next ask tries again. Short,
 * because it is usually a dropped connection: a wall opened offline should not
 * draw without its look for the whole revalidation window once it is back.
 */
export const LOOK_RETRY_AFTER_FAILURE_MS = 30 * 1000;

type KnownLook = { look: SprayWallRenderSettingsValue | null; settledAtMs: number; freshForMs: number };

const looks = new Map<string, KnownLook>();
const looksInFlight = new Map<string, Promise<SprayWallRenderSettingsValue | null>>();
/**
 * Bumped, per wall, by every write to `looks` that is not a read's answer. A
 * read that started before one is stale: the look step's save can land while
 * the draft's own read is still in flight, and that read's older answer must
 * not overwrite the look the climber just picked. `lookEpoch` does the same for
 * every wall at once when the cache is cleared.
 */
const lookWrites = new Map<string, number>();
let lookEpoch = 0;

/**
 * A wall's stored look, sanitised, or null when it has none.
 *
 * Never rejects. The look is optional: a failed read (offline, or a backend that
 * predates the field) keeps the last look this session knew, or none, and the
 * wall draws in the viewer's own settings. Answers are kept for the registry's
 * revalidation window, so a backend without the field is asked once per window,
 * not once per row.
 */
export function fetchSprayWallLook(wallUuid: string): Promise<SprayWallRenderSettingsValue | null> {
  const known = looks.get(wallUuid);
  if (known && Date.now() - known.settledAtMs < known.freshForMs) return Promise.resolve(known.look);
  const pending = looksInFlight.get(wallUuid);
  if (pending) return pending;

  const writesAtStart = lookWrites.get(wallUuid) ?? 0;
  const epochAtStart = lookEpoch;
  // Started inside a `then` so a client that throws synchronously still lands
  // in the failure branch below rather than escaping as an exception.
  const request = Promise.resolve()
    .then(() => getHttpClient().request<SprayWallLookResponse>(GET_SPRAY_WALL_LOOK, { uuid: wallUuid }))
    .then(
      // A `JSON` scalar off the wire, so it is validated rather than trusted:
      // anything that is not a usable look reads as "no stored look".
      (response) => ({
        look: sanitizeBoardRenderDefault(response?.sprayWall?.renderSettings),
        freshForMs: REGISTERED_WALL_REVALIDATE_MS,
      }),
      () => ({ look: known?.look ?? null, freshForMs: LOOK_RETRY_AFTER_FAILURE_MS }),
    )
    .then(({ look, freshForMs }) => {
      if ((lookWrites.get(wallUuid) ?? 0) !== writesAtStart || lookEpoch !== epochAtStart) {
        return looks.get(wallUuid)?.look ?? null;
      }
      looks.set(wallUuid, { look, settledAtMs: Date.now(), freshForMs });
      return look;
    })
    .finally(() => {
      if (looksInFlight.get(wallUuid) === request) looksInFlight.delete(wallUuid);
    });
  looksInFlight.set(wallUuid, request);
  return request;
}

/** Fetch a wall's look and hand it to the registered wall, if it is still that wall. */
export async function loadSprayWallLook(layoutId: number, wallUuid: string): Promise<void> {
  setSprayWallLook(layoutId, wallUuid, await fetchSprayWallLook(wallUuid));
}

/**
 * Record a look this device just stored, so the next read does not wait out the
 * window holding the answer from before the write. Sanitised like a read, so
 * the registry only ever holds looks in one shape.
 */
export function primeSprayWallLook(
  layoutId: number,
  wallUuid: string,
  look: SprayWallRenderSettingsValue | null,
): void {
  const clean = look === null ? null : sanitizeBoardRenderDefault(look);
  lookWrites.set(wallUuid, (lookWrites.get(wallUuid) ?? 0) + 1);
  looksInFlight.delete(wallUuid);
  looks.set(wallUuid, { look: clean, settledAtMs: Date.now(), freshForMs: REGISTERED_WALL_REVALIDATE_MS });
  setSprayWallLook(layoutId, wallUuid, clean);
}

/** Test seam: forget every look this session has read. */
export function clearSprayWallLooks(): void {
  lookEpoch += 1;
  looks.clear();
  looksInFlight.clear();
  lookWrites.clear();
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
  // Part of the KEY, not only a stamp. The payload carries `viewerCanEdit`,
  // which is one account's answer, so a request still in flight for the last
  // account must not be the one a caller under the new account is handed
  // (React Query shares an in-flight fetch between callers of one key), and a
  // payload cached for the last account must not be read back as fresh.
  viewerGeneration: number = sprayWallViewerGeneration(),
): Promise<SprayWallRenderData | null> {
  return queryClient
    .fetchQuery({
      queryKey: sprayWallPublishedRenderDataQueryKey(wallUuid, viewerGeneration),
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
async function loadSprayWallOnline(
  queryClient: QueryClient,
  layoutId: number,
  options?: { force?: boolean },
): Promise<void> {
  const removalGeneration = sprayWallRemovalGeneration(layoutId);
  const generation = sprayPrivacyGeneration(layoutId);
  const loaderEpoch = sprayWallLoaderGeneration();
  const isCurrent = () =>
    generation === sprayPrivacyGeneration(layoutId) &&
    loaderEpoch === sprayWallLoaderGeneration() &&
    removalGeneration === sprayWallRemovalGeneration(layoutId);
  // A read that failed for a wall withdrawn meanwhile is not a failure to report.
  const settleStale = (error: unknown) => {
    if (!isCurrent()) return null;
    throw error;
  };
  const wallUuid = await fetchSprayWallUuid(queryClient, layoutId).catch(settleStale);
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

  // Noted before the request leaves. If the account changes while it is out,
  // the answer's `viewerCanEdit` belongs to somebody else: ask once more under
  // the account that is here now. A second change in the same breath is left to
  // the registry, which registers the wall as "cannot edit" and stale.
  let viewerGeneration = sprayWallViewerGeneration();
  let renderDataRead = fetchSprayWallRenderData(queryClient, wallUuid, viewerGeneration).catch(settleStale);
  // Alongside the render data, not after it: a wall registered without its look
  // draws in the viewer's settings, then draws again when the look lands, which
  // on a cold start doubles every spray surface's renders. Never rejects.
  const lookRead = fetchSprayWallLook(wallUuid);
  let renderData = await renderDataRead;
  if (!isCurrent()) return;
  if (viewerGeneration !== sprayWallViewerGeneration()) {
    viewerGeneration = sprayWallViewerGeneration();
    renderDataRead = fetchSprayWallRenderData(queryClient, wallUuid, viewerGeneration).catch(settleStale);
    renderData = await renderDataRead;
    if (!isCurrent()) return;
  }
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
  const look = await lookRead;
  if (!isCurrent()) return;
  registerRenderData(layoutId, renderData, look, viewerGeneration, removalGeneration);
}

/** Online authority wins; local mirrors are only a transport-unavailable fallback. */
export async function loadSprayWall(
  queryClient: QueryClient,
  layoutId: number,
  options?: { force?: boolean },
): Promise<void> {
  const viewerGeneration = sprayWallViewerGeneration();
  const removalGeneration = sprayWallRemovalGeneration(layoutId);
  const loadLocal = async () => {
    const { loadLocalSprayWall } = await import('./spray-wall-local-loader');
    const hydrated = await loadLocalSprayWall(layoutId, viewerGeneration, removalGeneration);
    // Reconnect may occur while native photo decoding owns the registry's
    // in-flight slot. Its refresh is skipped, so this load must finish the
    // authority read itself rather than leaving the fallback fresh for 10 min.
    if (hydrated && !getConnectivitySnapshot().effectiveOffline) {
      try {
        await loadSprayWallOnline(queryClient, layoutId, { force: true });
      } catch (error) {
        if (!isNetworkError(error)) {
          unregisterSprayWall(layoutId);
          throw error;
        }
      }
    }
    return hydrated;
  };
  if (getConnectivitySnapshot().effectiveOffline) {
    if (!(await loadLocal())) throw new Error('Downloaded spray wall photo unavailable');
    return;
  }
  try {
    await loadSprayWallOnline(queryClient, layoutId, options);
  } catch (error) {
    if ((getConnectivitySnapshot().effectiveOffline || isNetworkError(error)) && (await loadLocal())) return;
    throw error;
  }
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
 * The signed-in account changed: disown what the last account could edit, and
 * re-read each wall in hand.
 *
 * Called by the auth provider (the one component that survives a sign-out), on
 * every change of who is signed in. Synchronous on purpose: by the time it
 * returns, no wall says the viewer can edit it and no request in flight can say
 * so later (`resetSprayWallViewerAccess`). The refetch that follows is a
 * courtesy. A wall with a load already in flight is skipped by
 * `refreshSprayWall`; that load re-asks by itself when it sees the generation
 * moved (`loadSprayWall`), and failing that the wall is stamped stale, so the
 * next surface to ask for it fetches.
 */
export function refreshSprayWallViewerAccess(): void {
  for (const layoutId of resetSprayWallViewerAccess()) refreshSprayWall(layoutId);
}

/**
 * The account went away, and nothing is known yet about what replaces it.
 *
 * Drops `viewerCanEdit` everywhere and disowns requests in flight, exactly as
 * above, but fetches NOTHING and leaves the registrations fresh so nothing else
 * fetches either. A native keychain that fails for a moment flips the app to
 * signed-out without any cleanup, and requests sent in that state carry no
 * token (`authenticatedFetch` only sets the header when it reads one). A
 * private wall asked for like that resolves null and would be withdrawn from
 * under the live player. The refetch waits for `refreshSprayWallViewerAccess`,
 * on sign-in or after the signed-out cleanup.
 */
export function dropSprayWallViewerAccess(): void {
  resetSprayWallViewerAccess({ markStale: false });
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
  const requestedLayouts = new Map<number, { viewerGeneration: number; removalGeneration: number }>();
  const pruneRemovedRequests = () => {
    for (const [layoutId, requestedUnder] of requestedLayouts) {
      if (
        requestedUnder.viewerGeneration !== sprayWallViewerGeneration() ||
        requestedUnder.removalGeneration !== sprayWallRemovalGeneration(layoutId)
      )
        requestedLayouts.delete(layoutId);
    }
  };
  const unsubscribeRegistry = subscribeToSprayWalls(pruneRemovedRequests);
  const loader = (layoutId: number, options?: { force?: boolean }) => {
    if (!active) return Promise.resolve();
    requestedLayouts.set(layoutId, {
      viewerGeneration: sprayWallViewerGeneration(),
      removalGeneration: sprayWallRemovalGeneration(layoutId),
    });
    return loadSprayWall(queryClient, layoutId, options);
  };
  setSprayWallLoader(loader);
  let wasOffline = getConnectivitySnapshot().effectiveOffline;
  const unsubscribe = subscribeConnectivity(() => {
    const offline = getConnectivitySnapshot().effectiveOffline;
    const reconnected = wasOffline && !offline;
    wasOffline = offline;
    if (!reconnected) return;
    pruneRemovedRequests();
    for (const layoutId of requestedLayouts.keys()) {
      void queryClient.invalidateQueries({ queryKey: sprayWallByLayoutQueryKey(layoutId) });
      refreshSprayWall(layoutId);
    }
  });
  return () => {
    active = false;
    unsubscribe();
    unsubscribeRegistry();
    requestedLayouts.clear();
    unsubscribeWithdrawal();
    if (unsubscribeQueryWithdrawal === unsubscribeWithdrawal) unsubscribeQueryWithdrawal = undefined;
    unsetSprayWallLoader(loader);
  };
}
