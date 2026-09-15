// The walls this session knows how to draw (issue #5440).
//
// Every other board's geometry is bundled: `getBoardRenderData` reads generated
// constants keyed by `(boardName, layoutId, sizeId, setIds)`, and its background
// is a `.webp` inside the IPA/APK. A spray wall has neither. Its photo and its
// holds arrive from `sprayWallRenderData` at runtime, so the render path needs
// somewhere synchronous to read them back from — `getBoardRenderData`,
// `getCreateBoardHolds` and `tryGetBackgroundPathsSync` are all called on the
// draw path and none of them can await anything.
//
// This module is that place: a plain map, written by `useSprayWall` and read by
// everything downstream. It holds no React, does no I/O and imports nothing from
// the render path, so nothing here can become a cycle.
//
// ## The version is the whole point
//
// A wall reset writes a new `spray_wall_versions` row and a new generation of
// `spray_wall_holds`. It does NOT write a new layout or a new size — the wall
// keeps its `(board_type, layout_id)` partition forever so every climb ever set
// on it stays findable (`docs/spray-walls.md`, "What the version is not"), and
// encoding the version in `sizeId` was rejected because it would leak into
// `compatible_size_ids`, the offline key, `board_sessions.board_path` and share
// URLs.
//
// So the version has to reach the caches some other way, and `sprayCacheToken`
// is it. Every cache key on the spray render path — the render-data memo, the
// hold-target memo, the overlay PNG name, the background-path guard, the board
// config, the create-climb draft slot and the create screen's React key — folds
// this token in. Drop it from one of them and a reset shows the PREVIOUS
// generation's holds over the new photo, which is the one failure this whole
// slice exists to prevent.

import { boardArtGeometryKey, registerRuntimeGeometry, unregisterRuntimeGeometry } from '@boardsesh/board-art-geometry';
import type { BoardArtGeometry } from '@boardsesh/board-art-geometry/types';
import { spraySizeIdForLayout } from '@boardsesh/board-config';
import type { SprayPhotoHold } from './spray-hold-geometry';

/** The one board name a wall is ever registered under. */
export const SPRAY_BOARD_NAME = 'spray';

/**
 * One wall at one version, in that version's photo pixels.
 *
 * `photoUrl` is a 15-minute presigned signature over an object in the PRIVATE
 * bucket, so it is never persisted anywhere — the photo cache keys on
 * `(layoutId, version)` and re-reads the URL from here whenever it has to fetch.
 */
export type RegisteredSprayWall = {
  layoutId: number;
  wallUuid: string;
  /** `SprayWallVersion.number`: 1-based and dense per wall. */
  version: number;
  photoWidth: number;
  photoHeight: number;
  photoUrl: string;
  /** Presigned GET for the largest stored resize variant, or null when there is none. */
  photoThumbUrl: string | null;
  /** ISO 8601 expiry of both signatures above. */
  photoExpiresAt: string;
  /** Alive holds only — `sprayWallRenderData` returns the generation alive AT this version. */
  holds: readonly SprayPhotoHold[];
};

const walls = new Map<number, RegisteredSprayWall>();

/** Listeners woken when a wall is registered, re-registered or dropped. */
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

/**
 * The shard key a wall's runtime geometry is published under.
 *
 * `spray/<layoutId>-<layoutId>`, because a wall's size id EQUALS its layout id
 * (`spraySizeIdForLayout`) — so `use-native-climb-render.ts` and the backend's
 * `board-geometry.ts` find it through the `boardArtGeometryKey(query)` call they
 * already make, with no branch of their own.
 */
export function sprayGeometryKey(layoutId: number): string {
  return boardArtGeometryKey({
    boardName: SPRAY_BOARD_NAME,
    layoutId,
    sizeId: spraySizeIdForLayout(layoutId),
  });
}

/**
 * The traced-art table for a wall: its holds' own silhouettes.
 *
 * `silhouetteLightness` and `ledBright` are empty and stay empty. A wall has no
 * LEDs at all, and nothing measures the photograph's brightness inside each
 * silhouette — an absent entry is exactly what the contract asks for (a consumer
 * must treat a missing placement as "no reading"), whereas a fabricated 0 would
 * paint every hold as if its art were black.
 */
function buildWallGeometry(holds: readonly SprayPhotoHold[]): BoardArtGeometry {
  const outlines: Record<number, number[]> = {};
  for (const hold of holds) {
    if (hold.outline) outlines[hold.id] = hold.outline;
  }
  return { outlines, silhouetteLightness: {}, ledBright: {} };
}

/**
 * Publish a wall, replacing any earlier version of the same wall.
 *
 * Replacement rather than merge: version 2's hold list is the wall as it is now,
 * and a hold that came off must disappear rather than linger because it was
 * registered once.
 */
export function registerSprayWall(layoutId: number, wall: Omit<RegisteredSprayWall, 'layoutId'>): void {
  walls.set(layoutId, { ...wall, layoutId });
  loadStates.set(layoutId, { state: 'ready', settledAtMs: now() });
  registerRuntimeGeometry(sprayGeometryKey(layoutId), buildWallGeometry(wall.holds));
  notify();
}

/** The wall registered for a layout id, or `null`. O(1); safe on a list row. */
export function getSprayWall(layoutId: number): RegisteredSprayWall | null {
  return walls.get(layoutId) ?? null;
}

/** Drop a wall and its runtime geometry, so the render path reports no board rather than a stale one. */
export function unregisterSprayWall(layoutId: number): void {
  loadStates.set(layoutId, { state: 'unavailable', settledAtMs: now() });
  if (!walls.delete(layoutId)) {
    notify();
    return;
  }
  unregisterRuntimeGeometry(sprayGeometryKey(layoutId));
  notify();
}

// ============================================
// Loading a wall nobody has asked for yet
// ============================================

/**
 * What this session knows about a wall it has not got.
 *
 * `unavailable` covers every reason a wall did not arrive — it does not exist,
 * the viewer may not see it, nothing is published, the fetch failed — because a
 * surface cannot do anything different about any of them. They differ only in
 * whether retrying helps, which the cooldown below handles without the caller
 * needing to know.
 */
export type SprayWallLoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

type LoadRecord = { state: SprayWallLoadState; settledAtMs: number };

/**
 * How long a failed load is left alone before `ensureSprayWallLoaded` tries
 * again.
 *
 * Sticky failure is the wrong default here: the common reason a wall does not
 * arrive is a phone with no signal, and a permanently `unavailable` wall would
 * be a board that stays blank until the app is killed. Thirty seconds is long
 * enough that a scrolling list of that wall's climbs does not hammer the
 * backend — every row asks, one row fetches — and short enough that coming back
 * into coverage fixes the board on the next scroll.
 */
const LOAD_RETRY_COOLDOWN_MS = 30_000;

const loadStates = new Map<number, LoadRecord>();

/** Injected so this module fetches nothing itself — see `setSprayWallLoader`. */
type SprayWallLoader = (layoutId: number, options?: { force?: boolean }) => Promise<void>;
let sprayWallLoader: SprayWallLoader | null = null;

function now(): number {
  return Date.now();
}

/**
 * Install the function that actually fetches a wall.
 *
 * Injected rather than imported because this module is read on the DRAW path —
 * `board-details.ts`, `create-board-holds.ts`, the two render-board resolvers —
 * and importing the GraphQL client here would put `expo-secure-store` and the
 * whole auth chain into every one of their module graphs. The React side calls
 * this once at the app root; until it does, `ensureSprayWallLoaded` is a no-op
 * and a wall only arrives through `useSprayWall`.
 */
export function setSprayWallLoader(loader: SprayWallLoader | null): void {
  sprayWallLoader = loader;
}

/** What this session knows about a wall right now. O(1). */
export function getSprayWallLoadState(layoutId: number): SprayWallLoadState {
  if (walls.has(layoutId)) return 'ready';
  return loadStates.get(layoutId)?.state ?? 'idle';
}

/**
 * Make sure a wall is on its way, whoever resolved it.
 *
 * The active board is loaded by `useSprayWall`, but a wall reaches a surface in
 * four other ways — a queue item set on another wall, a playlist row, a second
 * wall in My Boards, and `resolveClimbRenderBoard` falling a climb back onto its
 * own board — and none of those is the active board. Without this they resolve a
 * spray config the registry has never heard of, `getBoardRenderData` answers
 * null, and the surface draws a placeholder for the rest of the session with no
 * `Board Render Failed` to show for it.
 *
 * Safe to call from a render or a per-row resolver: a Map lookup, then at most
 * one in-flight fetch per wall. Fire-and-forget — the registry notifies its
 * subscribers when the wall lands, which is what re-renders the rows that asked.
 */
/**
 * Re-fetch a wall whose cached payload is known to be useless, bypassing both the
 * retry cooldown and React Query's stale window.
 *
 * The one caller is the photo cache meeting an expired presigned signature. That
 * URL will 403 on every attempt for as long as the payload holding it is
 * considered fresh, so without this the board shows a placeholder until something
 * else happens to invalidate the query — which, on a wall nobody navigates away
 * from, is never.
 */
export function refreshSprayWall(layoutId: number): void {
  if (!sprayWallLoader) return;
  if (loadStates.get(layoutId)?.state === 'loading') return;

  loadStates.set(layoutId, { state: 'loading', settledAtMs: 0 });
  void sprayWallLoader(layoutId, { force: true })
    .catch(() => {
      // Same as `ensureSprayWallLoaded`: every failure looks alike from here.
    })
    .finally(() => {
      if (walls.has(layoutId)) return;
      loadStates.set(layoutId, { state: 'unavailable', settledAtMs: now() });
      notify();
    });
}

export function ensureSprayWallLoaded(layoutId: number): void {
  if (walls.has(layoutId) || !sprayWallLoader) return;

  const record = loadStates.get(layoutId);
  if (record?.state === 'loading') return;
  if (record?.state === 'unavailable' && now() - record.settledAtMs < LOAD_RETRY_COOLDOWN_MS) return;

  loadStates.set(layoutId, { state: 'loading', settledAtMs: 0 });
  const load = sprayWallLoader(layoutId);
  void load
    .catch(() => {
      // The loader registers on success; every failure looks the same here.
    })
    .finally(() => {
      // `registerSprayWall` may already have moved this to `ready`; only a wall
      // that did NOT arrive is marked unavailable.
      if (walls.has(layoutId)) return;
      loadStates.set(layoutId, { state: 'unavailable', settledAtMs: now() });
      notify();
    });
}

/**
 * Every `(layoutId, version)` pair the session currently holds.
 *
 * The cache sweeper's live-key protection reads this: a photo belonging to a wall
 * somebody is looking at right now must survive a sweep, and the sweeper has only
 * filenames to go on.
 */
export function listRegisteredSprayWalls(): RegisteredSprayWall[] {
  return [...walls.values()];
}

/**
 * Subscribe to registry changes. Returns the unsubscribe function.
 *
 * `useSyncExternalStore`-shaped so a surface mounted before its wall arrived
 * re-renders once it does, without every board surface polling a module-level
 * map on each frame.
 */
export function subscribeToSprayWalls(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/**
 * The cache-key token for a board config: `''` for every catalogue board, and
 * `-sv<version>` for a spray wall.
 *
 * Empty for non-spray so no existing key changes by a single byte — every
 * overlay PNG already on disk, and every warm-up scan that matches on the
 * renderer-version prefix, keeps working exactly as before.
 *
 * `-sv0` for a wall that is not registered yet. That is not a fallback that has
 * to be right: with no registration there is no render data, so nothing is drawn
 * and nothing is cached under it. What it must do is DIFFER from every real
 * version, so the first paint after the query lands cannot read a key written
 * while the wall was unknown.
 */
export function sprayCacheToken(boardName: string, layoutId: number): string {
  if (boardName !== SPRAY_BOARD_NAME) return '';
  return `-sv${walls.get(layoutId)?.version ?? 0}`;
}

/** Forget every wall, its load state and the injected loader. Tests only. */
export function clearSprayWallRegistry(): void {
  for (const layoutId of walls.keys()) unregisterRuntimeGeometry(sprayGeometryKey(layoutId));
  walls.clear();
  loadStates.clear();
  sprayWallLoader = null;
  notify();
}
