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

import type {
  BoardClimbRecentSender,
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceStats,
  Climb,
  ClimbQueueItemInput,
  UserBoard,
} from '@boardsesh/shared-schema';
import type { MobileBoardPresenceClient } from './board-presence-client';
import { nowMs as currentNowMs } from '../clock';

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
export function buildScreenshotWallSeed(
  climbs: Climb[],
  boardAngle: number | null,
  boardOwner?: Pick<UserBoard, 'ownerId' | 'ownerDisplayName' | 'ownerAvatarUrl'>,
): BoardPresenceClimb[] {
  const nowMs = currentNowMs();
  return climbs.slice(0, SCREENSHOT_WALL_SEED_COUNT).map((climb, index) => ({
    climbUuid: climb.uuid,
    name: climb.name,
    grade: climb.difficulty,
    gradeColor: null,
    frames: climb.frames,
    angle: boardAngle ?? climb.angle,
    setter: climb.setter_username,
    // The capture demonstrates this recorded board owner's turn at the wall.
    // Identity comes from the sanitized fixture, never a hardcoded demo person.
    sentByDisplayName: boardOwner?.ownerDisplayName ?? null,
    sentByAvatarUrl: boardOwner?.ownerAvatarUrl ?? null,
    sentByUserId: boardOwner?.ownerId ?? null,
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

/** The climbs the app published (the board's real climbs). */
let publishedClimbs: BoardPresenceClimb[] = [];
/**
 * Climbs the fake-Bluetooth build reported lighting, newest first. Kept apart
 * from `publishedClimbs` so a re-publish of the same board (the Climbs screen
 * mounting) can't drop them: the wall stays on the last reported climb. A
 * publish for a different board clears them, since they belong to the old wall.
 */
let reportedClimbs: BoardPresenceClimb[] = [];
/** The board the published climbs (and so the reports) belong to. */
let publishedBoardKey: string | null = null;
/**
 * The highest `seq` handed out so far. The reducer drops any event at or below
 * the last seq it saw, so reports keep counting up from here even if a
 * re-publish brings the published climbs' own (lower) numbers back, and a new
 * board's climbs are lifted above it so its lit climb isn't dropped as stale.
 */
let highestSeq = 0;
/** What every feed method serves: reports on top of the published climbs. */
let seedClimbs: BoardPresenceClimb[] = [];
let seedHolder: BoardConnectionHolder | null = null;
const listeners = new Set<SeedListener>();

/** How many lit climbs the seed keeps once reports start stacking up. */
const SCREENSHOT_WALL_HISTORY_CAP = 20;

function refreshSeed(): void {
  seedClimbs =
    reportedClimbs.length > 0
      ? [...reportedClimbs, ...publishedClimbs].slice(0, SCREENSHOT_WALL_HISTORY_CAP)
      : publishedClimbs;
  for (const listener of listeners) {
    listener();
  }
}

function highestClimbSeq(climbs: readonly BoardPresenceClimb[]): number {
  return climbs.reduce((highest, climb) => Math.max(highest, climb.seq), 0);
}

/**
 * Publish the climbs to show on the wall (newest first — index 0 is the lit
 * climb). Called from ScreenshotBoardAutoActivator (root) and the Climbs screen
 * with the active board's real climbs. The seed persists at module scope, so it
 * survives any screen unmounting before the flow reaches the wall tab.
 *
 * `boardKey` names the board the climbs came from (its uuid). When it differs
 * from the previous publish's, the capture has switched walls: the old wall's
 * reports are dropped and the new climbs are numbered above everything handed
 * out so far, so the feed moves to the new board's lit climb. Leaving it out
 * keeps the reports and the numbering as they are.
 */
export function publishScreenshotWallClimbs(
  climbs: BoardPresenceClimb[],
  holder: BoardConnectionHolder | null,
  boardKey?: string,
): void {
  let nextClimbs = climbs;
  if (boardKey !== undefined && boardKey !== publishedBoardKey) {
    const switchedBoards = publishedBoardKey !== null;
    publishedBoardKey = boardKey;
    reportedClimbs = [];
    if (switchedBoards && highestSeq > 0) {
      const offset = highestSeq;
      nextClimbs = climbs.map((climb) => ({ ...climb, seq: climb.seq + offset }));
    }
  }
  publishedClimbs = nextClimbs;
  highestSeq = Math.max(highestSeq, highestClimbSeq(nextClimbs));
  seedHolder = holder;
  refreshSeed();
}

/**
 * Fake-Bluetooth screenshot builds only (`EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=1`):
 * the climb the phone just wrote to its pretend board becomes the lit climb, the
 * way the server echoes a real report back over the wall feed. Without it the
 * wall would stay on the seeded climb and the play view's pill could never say
 * "On the wall" for the climb on screen. The sender is the seeded board owner,
 * the account doing the capture.
 */
function recordScreenshotWallReport(item: ClimbQueueItemInput, angle: number | null): void {
  highestSeq = Math.max(highestSeq, highestClimbSeq(seedClimbs)) + 1;
  const owner = publishedClimbs[0] ?? seedClimbs[0];
  const reported: BoardPresenceClimb = {
    climbUuid: item.climb.uuid,
    queueItemUuid: item.uuid,
    name: item.climb.name,
    grade: item.climb.difficulty,
    gradeColor: null,
    frames: item.climb.frames,
    angle: angle ?? item.climb.angle,
    setter: item.climb.setter_username,
    sentByDisplayName: owner?.sentByDisplayName ?? null,
    sentByAvatarUrl: owner?.sentByAvatarUrl ?? null,
    sentByUserId: owner?.sentByUserId ?? null,
    sentAt: new Date(currentNowMs()).toISOString(),
    seq: highestSeq,
  };
  reportedClimbs = [reported, ...reportedClimbs].slice(0, SCREENSHOT_WALL_HISTORY_CAP);
  refreshSeed();
}

/**
 * Tests only: forget everything published and reported. Not part of the seed's
 * API; app code publishes with `publishScreenshotWallClimbs` and never resets.
 *
 * @internal
 */
export function _resetScreenshotWallSeedForTests(): void {
  publishedClimbs = [];
  reportedClimbs = [];
  seedClimbs = [];
  seedHolder = null;
  publishedBoardKey = null;
  highestSeq = 0;
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
          sentByUserId: hardest.sentByUserId ?? seedHolder?.userId ?? '',
          sentByDisplayName: hardest.sentByDisplayName,
          sentByAvatarUrl: hardest.sentByAvatarUrl,
          sentAt: hardest.sentAt,
        }
      : null,
    topGrade: hardest?.grade ?? null,
    lastSentAt: hardest?.sentAt ?? null,
  };
}

function seedRecentSenders(lastSentAt: string): BoardClimbRecentSender[] {
  return [
    { userId: 'screenshot-sender-alex', displayName: 'Alex', avatarUrl: null, lastSentAt },
    { userId: 'screenshot-sender-maya', displayName: 'Maya', avatarUrl: null, lastSentAt },
    { userId: 'screenshot-sender-sam', displayName: 'Sam', avatarUrl: null, lastSentAt },
  ];
}

/**
 * A `MobileBoardPresenceClient` that serves the module seed instead of a
 * graphql-ws transport. Every feed method reads the published climbs; the
 * resolve/report methods are inert stubs (BLE never connects in the simulator),
 * except that a fake-Bluetooth build's reports light the reported climb.
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
    async fetchRecentHistory() {
      await whenSeeded();
      return seedClimbs;
    },
    async fetchHistoryPage() {
      await whenSeeded();
      return { entries: seedClimbs, nextCursor: null };
    },
    async fetchHistory() {
      await whenSeeded();
      return seedClimbs;
    },
    async fetchClimbRecentSenders(_boardId, climbUuid, angle) {
      await whenSeeded();
      const climb = seedClimbs.find((candidate) => candidate.climbUuid === climbUuid && candidate.angle === angle);
      return climb ? seedRecentSenders(climb.sentAt) : [];
    },
    async fetchStats() {
      await whenSeeded();
      return seedStats();
    },
    async fetchConnection() {
      await whenSeeded();
      return seedHolder;
    },
    async reportDisconnect() {
      return true;
    },
    async reportClimb(_boardId, climb, angle) {
      if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && process.env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE === '1') {
        recordScreenshotWallReport(climb, angle);
      }
      return true;
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
