import type { SprayArtVariant, SprayVersionIdentity } from './spray-photo-keys';
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
import type { BoardRenderDefault } from '../board-render-settings';
import type { SprayPhotoHold } from './spray-hold-geometry';
import { revokeSprayPrivacy, sprayPrivacyGeneration, sprayMemoryGeneration } from './spray-privacy-generation';
import { artVariantForBackground, type SprayWallBackground } from './spray-wall-background';

/** The one board name a wall is ever registered under. */
export const SPRAY_BOARD_NAME = 'spray';

/**
 * A wall's own stored default look, already sanitised
 * (`sanitizeBoardRenderDefault`). Type-only import: the registry stays free of
 * the settings store at runtime.
 */
export type SprayWallRenderSettingsValue = BoardRenderDefault;

/**
 * A generated wall look for one version, on disk and ready to draw
 * (`sprayWallArt`, READY). Registered only once its file has downloaded, so the
 * switch from the photo is one registry write: the image and the holds move
 * together, never one without the other.
 */
export type RegisteredSprayArt = {
  variant: SprayArtVariant;
  /** The version the art was made from. Art for any other version is never drawn. */
  versionId: number;
  /** The art's pixel size: the canonical frame, scaled. */
  width: number;
  height: number;
  /** Art pixels per canonical pixel (`width / canonical frame width`). */
  scale: number;
  /** 15-minute presigned GET, re-read from here whenever the file has to be fetched again. */
  url: string;
  /** ISO 8601 expiry of `url`. */
  expiresAt: string;
  /**
   * Alive holds in the ART's pixels: canonical coordinates times
   * `width / canonical frame width`, with no homography.
   */
  holds: readonly SprayPhotoHold[];
};

/**
 * One wall at one version, in that version's photo pixels.
 *
 * `photoUrl` is a 15-minute presigned signature over an object in the PRIVATE
 * bucket, so it is never persisted anywhere — the photo cache keys on
 * `(layoutId, versionId)` and re-reads the URL from here whenever it has to fetch.
 */
export type RegisteredSprayWall = {
  layoutId: number;
  wallUuid: string;
  /**
   * The wall's fixed angle, from its `user_boards` row, or `null` when the payload
   * did not carry one.
   *
   * A wall does not adjust (`is_angle_adjustable` is false), so this is the one
   * angle its climbs may be set at — and the server rejects any other
   * (`assertSprayAngleMatchesWall`). The create-climb editor reads it from here
   * rather than from the route params, which can carry a stale or hand-edited
   * angle from a deep link.
   *
   * Nullable on purpose, and it is NOT the same choice `photoDimensions` makes
   * next door. A wall whose photo will not say its size cannot be DRAWN, so it is
   * refused outright; a wall that will not say its angle draws perfectly well, and
   * blanking the board over a field only the authoring path reads would trade a
   * working wall for a placeholder. Fabricating a number would be worse than
   * either: `authoringAngle` falls back to the caller's angle for a null, whereas
   * a plausible-looking 0 would make every publish fail the server's angle check
   * with nothing the setter could do about it.
   */
  angle: number | null;
  /**
   * What a climb share link needs from the wall's `user_boards` row: the slug
   * `/b/{slug}` routes on and the two visibility flags that decide whether there
   * is a link at all (`buildSprayClimbSharePath`).
   *
   * Optional because only the loader knows it; a registration without it (a
   * test fixture, or a payload whose `board` came back empty) shares no link
   * rather than a guessed one.
   */
  share?: { slug: string; isPublic: boolean; isUnlisted: boolean } | null;
  /** `SprayWallVersion.number`: 1-based and dense per wall. */
  version: number;
  /** Immutable database row id; discarded version numbers may be reused. */
  versionId: SprayVersionIdentity;
  /** Durable mirror file; only present on an owner-gated offline registration. */
  localPhotoPath?: string;
  photoWidth: number;
  photoHeight: number;
  photoUrl: string;
  /** Presigned GET for the largest stored resize variant, or null when there is none. */
  photoThumbUrl: string | null;
  /** ISO 8601 expiry of both signatures above. */
  photoExpiresAt: string;
  /** Alive holds only — `sprayWallRenderData` returns the generation alive AT this version. */
  holds: readonly SprayPhotoHold[];
  /**
   * This version's row-major photo→canonical homography, the matrix `holds` were
   * mapped back through.
   *
   * Kept so a hold that is NOT in `holds` — one a reset took off, drawn as a
   * ghost where a climb used it (#5493) — goes through the very same inverse and
   * lands on the same photo the live holds do. Optional because a fixture or an
   * older caller may register without one; a reader without it draws no ghosts.
   */
  homography?: readonly number[];
  /**
   * The look the wall's creator picked for it (`SprayWall.renderSettings`), or
   * `null` when none was stored or the stored value was unusable.
   *
   * Only a viewer on `mode: 'default'` ever sees it — an explicit choice of
   * their own always wins (`resolveEffectiveRenderSettings`). Sanitised on the
   * way in, so the render path reads it without re-validating.
   */
  renderSettings: SprayWallRenderSettingsValue | null;
  /**
   * What the wall's owner chose to draw it on (`render_settings.background`).
   * Missing means `photo`. Unlike `renderSettings` this applies to every viewer:
   * it is the wall's picture, not a drawing style.
   */
  background?: SprayWallBackground;
  /**
   * The generated look for this version, when one is on disk. Only drawn while
   * it matches `background` (`activeSprayArt`), so an owner switching back to
   * the photo takes effect at once. Every field above stays in PHOTO pixels: the
   * hold editor and the reset flows always work on the raw photo.
   */
  art?: RegisteredSprayArt | null;
  /**
   * Whether the signed-in viewer can edit this wall (`SprayWall.viewerCanEdit`):
   * its owner, an owner or admin of its gym, a community admin on a public wall.
   *
   * Read by one thing, the Edit action on a published climb somebody else set
   * (`canEditClimb`). It is a HINT about what the server will allow, not a
   * permission: `updateClimb` checks `canEditBoard` itself on every save.
   *
   * It is an answer about one ACCOUNT, in a registry that outlives a sign-out,
   * so it is only ever `true` for a payload fetched under the account that is
   * signed in now. See `sprayWallViewerGeneration`. It can also be ten minutes
   * behind a role change (the revalidation window).
   */
  viewerCanEdit: boolean;
  /**
   * Whether the signed-in viewer can edit published climbs on this wall
   * (`SprayWall.viewerCanEditClimbs`, #6025): wall editors, plus anyone who can
   * set climbs when the wall's climbEditPolicy is 'collaborators'.
   */
  viewerCanEditClimbs: boolean;
  /**
   * When this registration was made, for revalidation. Stamped by
   * `registerSprayWall`, never by the caller — a caller-supplied timestamp is a
   * caller that can accidentally pin a wall as fresh forever.
   */
  registeredAtMs: number;
};

/**
 * How long a REGISTERED wall is taken at face value before a fresh ask is let
 * through to the loader.
 *
 * Deliberately the same number as the render query's stale window, and that is
 * the whole design: this gate decides whether the loader is asked at all, React
 * Query then decides whether asking costs a request. Without it a registered wall
 * short-circuits every later ask, so a reset published from another device is
 * never seen until the app restarts, and the 15-minute presigned photo URL is
 * kept long past its expiry.
 */
export const REGISTERED_WALL_REVALIDATE_MS = 10 * 60 * 1000;

const walls = new Map<number, RegisteredSprayWall>();
let removalSequence = 0;
let registryRemovalGeneration = 0;
const wallRemovalGenerations = new Map<number, number>();

/** Stamp a load before I/O; removal makes its eventual registration stale. */
export function sprayWallRemovalGeneration(layoutId: number): number {
  return wallRemovalGenerations.get(layoutId) ?? registryRemovalGeneration;
}

/** Listeners woken when a wall is registered, re-registered or dropped. */
const subscribers = new Set<() => void>();
const withdrawalSubscribers = new Set<(layoutId?: number, wallUuid?: string) => void>();
let privacyCleanup: ((layoutId?: number) => void) | null = null;

/**
 * Platform I/O is injected by spray-privacy-cleanup, keeping this module pure.
 * AuthProvider imports that module at app bootstrap, before any wall surface;
 * registry-only consumers retain memory withdrawal without platform I/O.
 */
export function setSprayWallPrivacyCleanup(cleanup: (layoutId?: number) => void): void {
  privacyCleanup = cleanup;
}

/** Query owners erase payloads while the withdrawn identity is still available. */
export function subscribeToSprayWallWithdrawals(listener: (layoutId?: number, wallUuid?: string) => void): () => void {
  withdrawalSubscribers.add(listener);
  return () => {
    withdrawalSubscribers.delete(listener);
  };
}

function notifyWithdrawal(layoutId?: number): void {
  for (const subscriber of withdrawalSubscribers) {
    try {
      subscriber(layoutId, layoutId == null ? undefined : walls.get(layoutId)?.wallUuid);
    } catch {
      // A query owner's failure must not prevent file and geometry withdrawal.
    }
  }
}

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
 * The generated look a wall is drawn with right now, or `null` for its photo.
 *
 * Art is drawn only when it is for the registered version AND matches the
 * owner's chosen background. Everything that draws a wall reads this one
 * answer — the render data, the hold geometry, the cache token — so they can
 * never disagree about which picture the holds sit on.
 */
export function activeSprayArt(wall: RegisteredSprayWall | null | undefined): RegisteredSprayArt | null {
  const art = wall?.art;
  if (!wall || !art) return null;
  if (art.versionId !== wall.versionId) return null;
  return artVariantForBackground(wall.background) === art.variant ? art : null;
}

/** The holds as drawn: in the art's pixels when art is active, else the photo's. */
export function drawnSprayHolds(wall: RegisteredSprayWall): readonly SprayPhotoHold[] {
  return activeSprayArt(wall)?.holds ?? wall.holds;
}

/**
 * The generated look a registered wall asks for but does not have yet, or
 * `null`. The loader reads it to decide whether a look change needs a fetch.
 */
export function missingSprayArtVariant(layoutId: number): SprayArtVariant | null {
  const wall = walls.get(layoutId);
  if (!wall || typeof wall.versionId !== 'number') return null;
  const wanted = artVariantForBackground(wall.background);
  if (!wanted || activeSprayArt(wall)) return null;
  return wanted;
}

/** Whether two stored looks draw the same. Both are sanitised, so key order is fixed. */
function sameLook(left: SprayWallRenderSettingsValue | null, right: SprayWallRenderSettingsValue | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Publish a wall, replacing any earlier version of the same wall.
 *
 * Replacement rather than merge: version 2's hold list is the wall as it is now,
 * and a hold that came off must disappear rather than linger because it was
 * registered once.
 */
export function registerSprayWall(
  layoutId: number,
  // `renderSettings` left out means "not known by this registration", not "no
  // look": the render payload does not carry it (the look arrives separately,
  // through `setSprayWallLook`), so a revalidation must not wipe the look the
  // same wall already has. A different wall under the layout starts with none.
  //
  // `viewerAccess` is who-can-edit together with the viewer generation the
  // payload was FETCHED under. Left out means "cannot edit": an answer that does
  // not say the viewer may edit, or cannot say whose answer it is, must not put
  // an Edit action on screen. Never carried over from the previous registration.
  //
  // `background` left out keeps the same wall's previous one, like the look.
  // `art` left out keeps the previous art only while it is for this exact
  // version; anything else starts on the photo.
  wall: Omit<
    RegisteredSprayWall,
    'layoutId' | 'registeredAtMs' | 'renderSettings' | 'viewerCanEdit' | 'viewerCanEditClimbs'
  > & {
    renderSettings?: SprayWallRenderSettingsValue | null;
    viewerAccess?: SprayWallViewerAccess;
  },
): void {
  // An unchanged look keeps its previous identity. Every board surface on the
  // wall subscribes to it (`sprayBoardRenderDefault`), and a ten-minute
  // revalidation that hands back the same look must not re-resolve every row's
  // render settings for nothing.
  const previous = walls.get(layoutId);
  const previousLook = previous?.wallUuid === wall.wallUuid ? previous.renderSettings : null;
  const nextLook = wall.renderSettings === undefined ? previousLook : wall.renderSettings;
  const renderSettings = sameLook(previousLook, nextLook) ? previousLook : nextLook;
  const sameWall = previous?.wallUuid === wall.wallUuid;
  const background = wall.background ?? (sameWall ? previous?.background : undefined);
  const art =
    wall.art !== undefined
      ? wall.art
      : sameWall && previous?.art && previous.art.versionId === wall.versionId
        ? previous.art
        : null;
  const { viewerAccess, ...registration } = wall;
  // A payload fetched under an account that has since changed. The wall itself
  // is still the wall (photo and holds do not depend on who is looking), so it
  // registers and draws. But its `viewerCanEdit` is somebody else's answer, so
  // it is dropped, and the registration is stamped stale so the next ask goes
  // back to the server for this account instead of waiting out the window.
  const fetchedForAnotherViewer = viewerAccess !== undefined && viewerAccess.generation !== viewerGeneration;
  const registered: RegisteredSprayWall = {
    ...registration,
    renderSettings,
    background,
    art,
    viewerCanEdit: viewerAccess?.canEdit === true && !fetchedForAnotherViewer,
    viewerCanEditClimbs: (viewerAccess?.canEditClimbs ?? viewerAccess?.canEdit) === true && !fetchedForAnotherViewer,
    layoutId,
    registeredAtMs: fetchedForAnotherViewer ? 0 : now(),
  };
  walls.set(layoutId, registered);
  loadStates.set(layoutId, { state: 'ready', settledAtMs: now() });
  registerRuntimeGeometry(sprayGeometryKey(layoutId), buildWallGeometry(drawnSprayHolds(registered)));
  notify();
}

/**
 * Set a registered wall's stored look without re-registering it.
 *
 * Ignored when no wall is registered under the layout or a different wall is
 * (the answer is for a wall that has since been replaced), and a no-op when the
 * look is unchanged, so subscribers only wake for a real change.
 */
export function setSprayWallLook(
  layoutId: number,
  wallUuid: string,
  look: SprayWallRenderSettingsValue | null,
  // Left out keeps the background the wall has: a caller that only knows the
  // drawing style must not send the wall back to its photo.
  background?: SprayWallBackground,
): void {
  const wall = walls.get(layoutId);
  if (!wall || wall.wallUuid !== wallUuid) return;
  const nextBackground = background ?? wall.background;
  const lookChanged = !sameLook(wall.renderSettings, look);
  const backgroundChanged = (nextBackground ?? 'photo') !== (wall.background ?? 'photo');
  if (!lookChanged && !backgroundChanged) return;
  const updated: RegisteredSprayWall = {
    ...wall,
    renderSettings: lookChanged ? look : wall.renderSettings,
    background: nextBackground,
  };
  walls.set(layoutId, updated);
  // The holds move with the picture: switching between the photo and a
  // generated look changes every hold's coordinates and silhouette.
  if (activeSprayArt(wall) !== activeSprayArt(updated)) {
    registerRuntimeGeometry(sprayGeometryKey(layoutId), buildWallGeometry(drawnSprayHolds(updated)));
  }
  notify();
}

/** The wall registered for a layout id, or `null`. O(1); safe on a list row. */
export function getSprayWall(layoutId: number): RegisteredSprayWall | null {
  return walls.get(layoutId) ?? null;
}

/**
 * A board's stored default look: the registered wall's for a spray board,
 * `null` for every catalogue board (they have none) and for a wall not
 * registered yet.
 *
 * Shaped as a `useSyncExternalStore` snapshot: the same object comes back
 * until the wall is re-registered, so a subscriber re-renders only when a
 * registration actually lands.
 */
export function sprayBoardRenderDefault(boardName: string, layoutId: number): SprayWallRenderSettingsValue | null {
  if (boardName !== SPRAY_BOARD_NAME) return null;
  return walls.get(layoutId)?.renderSettings ?? null;
}

/**
 * Whether the viewer can edit the wall a board config points at. `false` for
 * every catalogue board and for a wall that is not registered.
 *
 * A boolean, so it is safe as a `useSyncExternalStore` snapshot as it stands.
 */
export function sprayWallViewerCanEdit(boardName: string, layoutId: number): boolean {
  if (boardName !== SPRAY_BOARD_NAME) return false;
  return walls.get(layoutId)?.viewerCanEdit === true;
}

/**
 * Whether the viewer can edit published climbs on this wall (#6025). `false` for
 * every catalogue board and for a wall that is not registered.
 */
export function sprayWallViewerCanEditClimbs(boardName: string, layoutId: number): boolean {
  if (boardName !== SPRAY_BOARD_NAME) return false;
  return walls.get(layoutId)?.viewerCanEditClimbs === true;
}

/**
 * Who-can-edit, with the viewer generation its payload was fetched under.
 * `generation` is read with `sprayWallViewerGeneration()` BEFORE the request
 * goes out, never after it comes back.
 */
export type SprayWallViewerAccess = { canEdit: boolean; canEditClimbs?: boolean; generation: number };

/**
 * Counts account changes. Bumped by `resetSprayWallViewerAccess`.
 *
 * This is how `viewerCanEdit` is tied to an account without the registry
 * knowing who anyone is (native auth does not hand the provider a user id).
 * A fetch notes the generation when it STARTS; a registration is only believed
 * about `viewerCanEdit` if the generation is still that one when it lands. So a
 * request that left under the previous account and came back after the switch
 * cannot put that account's Edit action in front of the next person.
 */
let viewerGeneration = 0;

export function sprayWallViewerGeneration(): number {
  return viewerGeneration;
}

/**
 * The signed-in account changed, in either direction.
 *
 * Module state on purpose, called from the auth provider, which is the one
 * thing that stays mounted across a sign-out. The app tree below it is REPLACED
 * on every auth change (a redirect or the splash is rendered instead of its
 * children), so a hook down there never sees a "before".
 *
 * Three things happen. The generation moves, which disowns every request in
 * flight. `viewerCanEdit` drops to `false` on every wall at once, so a wall
 * owner signing out does not leave Edit on screen for whoever picks the phone
 * up next. And every registration is stamped stale, so the next ask goes back
 * to the server and a climber who has just signed IN gets their own answer
 * rather than the anonymous `false` for the rest of the window.
 *
 * The walls themselves stay registered: the photo and the holds do not depend
 * on who is looking, and blanking every board over a sign-in would be a flash
 * for nothing. Returns the layout ids it touched so the caller can refresh them.
 */
export function resetSprayWallViewerAccess({ markStale = true }: { markStale?: boolean } = {}): number[] {
  viewerGeneration += 1;
  if (walls.size === 0) {
    notify();
    return [];
  }
  const layoutIds: number[] = [];
  for (const [layoutId, wall] of walls) {
    if (wall.localPhotoPath) {
      layoutIds.push(layoutId);
      unregisterSprayWall(layoutId);
      continue;
    }
    // `markStale: false` keeps the registration fresh, so no surface is invited
    // to refetch the wall. For a caller that knows the account is gone but not
    // that a request sent now would carry a token (`dropSprayWallViewerAccess`).
    walls.set(layoutId, {
      ...wall,
      viewerCanEdit: false,
      viewerCanEditClimbs: false,
      registeredAtMs: markStale ? 0 : wall.registeredAtMs,
    });
    layoutIds.push(layoutId);
  }
  notify();
  return layoutIds;
}

/** Drop a wall and its runtime geometry, so the render path reports no board rather than a stale one. */
export function unregisterSprayWall(layoutId: number): void {
  wallRemovalGenerations.set(layoutId, ++removalSequence);
  revokeSprayPrivacy(layoutId);
  notifyWithdrawal(layoutId);
  privacyCleanup?.(layoutId);
  inFlightLoads.delete(layoutId);
  deferredRequests.delete(layoutId);
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

/**
 * Walls asked for while no loader was installed, replayed by
 * `setSprayWallLoader`. Bounded by the number of distinct walls one screen can
 * resolve in a single commit.
 */
const deferredRequests = new Set<number>();

/**
 * Walls with a load in flight right now.
 *
 * `loadStates` cannot carry this on its own: a REVALIDATION leaves the state at
 * `ready` (the board is on screen and must not flash a placeholder), so without a
 * separate set the second row to ask would start a second load. React Query would
 * still collapse the network call, but the bookkeeping either side of it would
 * run twice.
 */
const inFlightLoads = new Set<number>();

/** Injected so this module fetches nothing itself — see `setSprayWallLoader`. */
type SprayWallLoader = (layoutId: number, options?: { force?: boolean }) => Promise<void>;
let sprayWallLoader: SprayWallLoader | null = null;
let loaderGeneration = 0;
export function sprayWallLoaderGeneration(): number {
  return loaderGeneration;
}

export function unsetSprayWallLoader(expected: SprayWallLoader): void {
  if (sprayWallLoader === expected) setSprayWallLoader(null);
}

function now(): number {
  return Date.now();
}

/**
 * Settle a wall as unavailable, notifying only if that is news.
 *
 * `loadSprayWall` calls `unregisterSprayWall` for a wall that resolved to
 * nothing, and that already notifies — so the `finally` below would notify a
 * second time for one answer. React deduplicates the identical snapshot, so this
 * costs nothing today; it is still one wake-up per state change rather than per
 * code path, which is the contract a subscriber should be able to rely on.
 */
function markUnavailable(layoutId: number): void {
  const previous = loadStates.get(layoutId);
  loadStates.set(layoutId, { state: 'unavailable', settledAtMs: now() });
  if (previous?.state === 'unavailable') return;
  notify();
}

/** A cold by-layout miss is discovery failure; an existing wall losing access is withdrawal. */
export function settleSprayWallDiscoveryMiss(layoutId: number): void {
  if (walls.has(layoutId)) unregisterSprayWall(layoutId);
  else markUnavailable(layoutId);
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
  loaderGeneration += 1;
  for (const layoutId of inFlightLoads) deferredRequests.add(layoutId);
  inFlightLoads.clear();
  sprayWallLoader = loader;
  if (!loader) return;

  // Everything that asked before the loader existed. This gap is real and not
  // rare: the loader is installed from a provider's `useEffect`, and React runs
  // CHILD effects before its parent's, so every row in the first commit resolves
  // its board while `sprayWallLoader` is still null. Those asks were dropped on
  // the floor, and a row that never re-renders — a list that is not scrolled, a
  // thumbnail that is already settled — kept its placeholder for the session.
  const deferred = [...deferredRequests];
  deferredRequests.clear();
  for (const layoutId of deferred) ensureSprayWallLoaded(layoutId);

  // And wake anything that asked from a RENDER rather than an effect (the
  // per-row resolvers), so it re-renders and asks again.
  notify();
}

/** What this session knows about a wall right now. O(1). */
export function getSprayWallLoadState(layoutId: number): SprayWallLoadState {
  if (walls.has(layoutId)) return 'ready';
  return loadStates.get(layoutId)?.state ?? 'idle';
}

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
  if (!sprayWallLoader || inFlightLoads.has(layoutId)) return;

  if (!walls.has(layoutId)) loadStates.set(layoutId, { state: 'loading', settledAtMs: 0 });
  inFlightLoads.add(layoutId);
  const generation = sprayPrivacyGeneration(layoutId);
  const loaderEpoch = loaderGeneration;
  void sprayWallLoader(layoutId, { force: true })
    .catch(() => {
      // Same as `ensureSprayWallLoaded`: every failure looks alike from here.
    })
    .finally(() => {
      if (generation !== sprayPrivacyGeneration(layoutId) || loaderEpoch !== loaderGeneration) return;
      inFlightLoads.delete(layoutId);
      if (walls.has(layoutId)) return;
      markUnavailable(layoutId);
    });
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
 *
 * An ask that arrives before the loader is installed is REMEMBERED rather than
 * dropped; see `setSprayWallLoader`.
 */
export function ensureSprayWallLoaded(layoutId: number): void {
  // A wall already in hand is only short-circuited while its registration is
  // still fresh. Past that the ask goes through: React Query's own stale window
  // decides whether it costs a request, and a reset published from another
  // device — or a presigned photo URL that has since expired — is picked up
  // instead of surviving until the app restarts.
  const registered = walls.get(layoutId);
  if (registered && now() - registered.registeredAtMs < REGISTERED_WALL_REVALIDATE_MS) return;

  if (!sprayWallLoader) {
    deferredRequests.add(layoutId);
    return;
  }

  if (inFlightLoads.has(layoutId)) return;
  const record = loadStates.get(layoutId);
  if (record?.state === 'unavailable' && now() - record.settledAtMs < LOAD_RETRY_COOLDOWN_MS) return;

  // A revalidation of a wall we already hold must not advertise itself as
  // `loading`: the board is on screen and drawable, and a surface reading the
  // state would flash its placeholder for a refresh nobody asked to see.
  if (!registered) loadStates.set(layoutId, { state: 'loading', settledAtMs: 0 });
  inFlightLoads.add(layoutId);
  const generation = sprayPrivacyGeneration(layoutId);
  const loaderEpoch = loaderGeneration;
  void sprayWallLoader(layoutId)
    .catch(() => {
      // The loader registers on success; every failure looks the same here.
    })
    .finally(() => {
      if (generation !== sprayPrivacyGeneration(layoutId) || loaderEpoch !== loaderGeneration) return;
      inFlightLoads.delete(layoutId);
      // `registerSprayWall` may already have moved this to `ready`; only a wall
      // that did NOT arrive is marked unavailable. A revalidation that failed
      // keeps the copy it has rather than blanking a board that still draws.
      if (walls.has(layoutId)) return;
      markUnavailable(layoutId);
    });
}

/**
 * Every `(layoutId, versionId)` pair the session currently holds.
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
  // `-bg<variant>` only while a generated look is drawn: the photo's token is
  // byte-identical to what it was before art existed, so no overlay on disk moves.
  const art = activeSprayArt(walls.get(layoutId));
  const background = art ? `-bg${art.variant}` : '';
  return `${sprayIdentityToken(boardName, layoutId)}${background}`;
}

/**
 * `sprayCacheToken` without the picture: the version and the privacy
 * generation only. For keys that name what a climber is EDITING rather than
 * what is drawn — the create screen's React key, the web draft slot — which
 * must not move when a generated look lands mid-paint (that would remount the
 * editor and lose its undo history). `''` for every catalogue board.
 */
export function sprayIdentityToken(boardName: string, layoutId: number): string {
  if (boardName !== SPRAY_BOARD_NAME) return '';
  return `${sprayVersionToken(boardName, layoutId)}-pr${sprayMemoryGeneration(layoutId)}`;
}

/**
 * Persisted editor drafts use the wall version, never a session generation. The
 * version is its immutable row id: a discarded version's number can be reused.
 */
export function sprayVersionToken(boardName: string, layoutId: number): string {
  return boardName === SPRAY_BOARD_NAME ? `-svid${walls.get(layoutId)?.versionId ?? 0}` : '';
}

/** Sign-out: withdraw every wall, disown loads in flight and erase private caches. */
export function withdrawAllSprayWalls(): void {
  registryRemovalGeneration = ++removalSequence;
  wallRemovalGenerations.clear();
  revokeSprayPrivacy();
  notifyWithdrawal();
  privacyCleanup?.();
  for (const layoutId of walls.keys()) unregisterRuntimeGeometry(sprayGeometryKey(layoutId));
  walls.clear();
  loadStates.clear();
  deferredRequests.clear();
  inFlightLoads.clear();
  notify();
}

/**
 * Forget every wall, its load state, the injected loader AND every subscriber.
 * Tests only.
 *
 * Subscribers are cleared last, after the notify: a listener left behind by an
 * earlier case would otherwise still be attached when the NEXT case runs its own
 * clear, and observe a call it never asked for — which is exactly how a
 * subscriber-call-count assertion goes green for the wrong reason.
 */
export function clearSprayWallRegistry(): void {
  withdrawAllSprayWalls();
  loaderGeneration += 1;
  sprayWallLoader = null;
  viewerGeneration = 0;
  subscribers.clear();
  withdrawalSubscribers.clear();
}
