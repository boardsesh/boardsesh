// Screenshot mode ONLY: a mobile-local seed for the iPad "On the Wall" kiosk, so
// the App Store capture shows a lit climb + recent history instead of the empty
// "Connect a board" state.
//
// This is the ONE deliberate exception to screenshot-mode's "presentation switch,
// not a data-mocking layer" rule (see `../screenshot-mode.ts`): the wall feed is a
// live graphql-ws subscription keyed on a `boardId` that only a BLE bind can set,
// and the simulator has no Bluetooth — so there is no seeded-backend path to a lit
// wall. Instead of hitting the backend, the mobile board-presence provider swaps in
// the seed client below when `EXPO_PUBLIC_SCREENSHOT_MODE === '1'`.
//
// The seed climbs are REAL climbs from the active board's list, published by the
// root ScreenshotBoardAutoActivator as soon as the board activates (and
// re-published by the Climbs screen when it mounts). Because they carry the real
// `frames` for whatever board the capture user follows, the kiosk lights the real
// holds — no hardcoded, board-specific frame string that would render dark on a
// different board (the known lit-climb gotcha).
//
// Everything here is reached only from inlined `EXPO_PUBLIC_SCREENSHOT_MODE === '1'`
// branches, so babel/terser dead-strips the whole module from normal builds.

import type { BoardConnectionHolder, BoardPresenceClimb, BoardPresenceStats, Climb } from '@boardsesh/shared-schema';
import type { MobileBoardPresenceClient } from './board-presence-client';

/** How many of the active board's climbs the wall kiosk history is seeded with. */
export const SCREENSHOT_WALL_SEED_COUNT = 6;

/**
 * Map the active board's real climbs (the first page of the default search) to
 * the wall-seed shape. Shared by the Climbs screen and the root
 * ScreenshotBoardAutoActivator so the kiosk lights the same holds no matter
 * which publisher runs first — the iPad capture must not depend on the Climbs
 * screen ever mounting (its sidebar tap has missed on the 11" iPad, shipping a
 * "WALL IS DARK" hero shot).
 */
export function buildScreenshotWallSeed(climbs: Climb[], boardAngle: number | null): BoardPresenceClimb[] {
  const nowMs = Date.now();
  return climbs.slice(0, SCREENSHOT_WALL_SEED_COUNT).map((climb, index) => ({
    climbUuid: climb.uuid,
    name: climb.name,
    grade: climb.difficulty,
    gradeColor: null,
    frames: climb.frames,
    angle: boardAngle ?? climb.angle,
    setter: climb.setter_username,
    sentByDisplayName: null,
    sentByAvatarUrl: null,
    sentByUserId: null,
    // Stagger the timestamps a few minutes apart so the history reads like a
    // real session rather than a burst.
    sentAt: new Date(nowMs - index * 4 * 60_000).toISOString(),
    seq: 100 - index,
  }));
}

/**
 * Sentinel `boardId` that flips the wall "live" (`WallScreen`'s `isWallLive`
 * gate is `boardId !== null`) in screenshot mode. The seed client ignores it and
 * never reaches a backend, so any non-null value works.
 */
export const SCREENSHOT_SEED_BOARD_ID = 999_000;

type SeedListener = () => void;

let seedClimbs: BoardPresenceClimb[] = [];
let seedHolder: BoardConnectionHolder | null = null;
const listeners = new Set<SeedListener>();

/**
 * Publish the climbs to show on the wall (newest first — index 0 is the lit
 * climb). Called from ScreenshotBoardAutoActivator (root) and the Climbs screen
 * with the active board's real climbs. The seed persists at module scope, so it
 * survives any screen unmounting before the flow reaches the wall tab.
 */
export function publishScreenshotWallClimbs(climbs: BoardPresenceClimb[], holder: BoardConnectionHolder | null): void {
  seedClimbs = climbs;
  seedHolder = holder;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Resolve once the seed has climbs. The board-presence hook calls
 * `fetchRecentClimbs`/`fetchStats` ONCE, at app boot — before the Climbs screen
 * has published — so returning the (empty) seed immediately would leave the kiosk
 * with a lit current climb but an empty history reel and 0/— stat tiles. Awaiting
 * the first publish instead lets those one-shot fetches deliver the full history +
 * stats whenever the Climbs screen runs (already-published → resolves at once).
 */
function whenSeeded(): Promise<void> {
  if (seedClimbs.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      listeners.delete(listener);
      resolve();
    };
    listeners.add(listener);
  });
}

function currentSeedClimb(): BoardPresenceClimb | null {
  return seedClimbs[0] ?? null;
}

function seedStats(): BoardPresenceStats {
  const hardest = currentSeedClimb();
  return {
    climbsSentCount: seedClimbs.length,
    // Someone lit these climbs, so show at least one climber rather than a
    // jarring "0" on the tile when no explicit holder is seeded.
    distinctClimbersCount: seedClimbs.length > 0 ? 1 : 0,
    hardestGrade: hardest?.grade ?? null,
    hardestSend: hardest
      ? {
          climbUuid: hardest.climbUuid,
          name: hardest.name,
          grade: hardest.grade ?? '',
          sentByUserId: seedHolder?.userId ?? '',
          sentByDisplayName: hardest.sentByDisplayName,
          sentByAvatarUrl: hardest.sentByAvatarUrl,
          sentAt: hardest.sentAt,
        }
      : null,
    topGrade: hardest?.grade ?? null,
    lastSentAt: hardest?.sentAt ?? null,
  };
}

/**
 * A `MobileBoardPresenceClient` that serves the module seed instead of a
 * graphql-ws transport. Every feed method reads the published climbs; the
 * resolve/report methods are inert stubs (BLE never connects in the simulator).
 */
export function createScreenshotBoardPresenceClient(): MobileBoardPresenceClient {
  const resolvedBoard = {
    boardId: SCREENSHOT_SEED_BOARD_ID,
    boardName: 'kilter',
    boardType: 'kilter',
    layoutId: 0,
    sizeId: 0,
    setIds: '',
  };
  return {
    subscribeNowPlaying(_boardId, onEvent) {
      const emit = () => {
        const climb = currentSeedClimb();
        if (climb) {
          onEvent({ __typename: 'BoardClimbSet', climb });
        }
      };
      // Emit whatever is already seeded, then re-emit on every later publish so
      // the wall lights up whether the Climbs screen ran before or after this
      // subscription attached.
      emit();
      listeners.add(emit);
      return () => {
        listeners.delete(emit);
      };
    },
    onReconnect() {
      return () => {};
    },
    async fetchRecentClimbs() {
      await whenSeeded();
      return seedClimbs;
    },
    async fetchHistory() {
      await whenSeeded();
      return seedClimbs;
    },
    async fetchStats() {
      await whenSeeded();
      return seedStats();
    },
    async fetchConnection() {
      await whenSeeded();
      return seedHolder;
    },
    async fetchLayers() {
      return null;
    },
    async reportDisconnect() {
      return true;
    },
    async reportClimb() {
      return true;
    },
    async reportLayers() {
      throw new Error('Quantum layers are unavailable in screenshot mode');
    },
    async resolveBoardForSerial() {
      return resolvedBoard;
    },
    async resolveBoardForUuid() {
      return resolvedBoard;
    },
    async resolveBoardForConfig() {
      return resolvedBoard;
    },
    async resolveBoardCandidatesForSerial() {
      return { board: resolvedBoard };
    },
    async chooseBoardForSerial() {
      return resolvedBoard;
    },
  };
}
