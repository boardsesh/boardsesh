import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOWCASE_TAKE_IDS, type ShowcaseAnchorName, type ShowcaseTakeId } from './contract';
import { SHOWCASE_SCENES, requiredTakeSeconds } from './timeline';

/**
 * How each take is captured: which deep link sets it up, which Maestro flow
 * drives it, and what the recorder checks afterwards. The recorder
 * (`scripts/showcase-video-record.ts`) reads nothing about a take from anywhere
 * else, so adding or changing a take starts here. See docs/showcase-video.md.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SHOWCASE_FLOW_DIR = resolve(REPO_ROOT, 'packages/mobile/.maestro/showcase');

/** Which wall a take sits on. The index is the slot in `EXPO_PUBLIC_SCREENSHOT_BOARDS`. */
export type ShowcaseBoardKind = 'kilter' | 'tension' | 'moonboard';
export const SHOWCASE_BOARD_SLOTS: readonly ShowcaseBoardKind[] = ['kilter', 'tension', 'moonboard'];

/** The phone the take is recorded on. Only `crew` drives a second one. */
export type ShowcaseDeviceRole = 'primary' | 'secondary';

export type ShowcaseTake = Readonly<{
  id: ShowcaseTakeId;
  /** One line for the run log and the runbook. */
  summary: string;
  /** Always `primary`: the recorded phone. A take with `secondary` also drives the other one. */
  role: 'primary';
  /**
   * Routes (after `com.boardsesh.app://`) opened in order on a freshly launched
   * app BEFORE recording starts, so the deep-link dialog and the screen's first
   * load stay out of the footage.
   */
  primeLinks: readonly string[];
  /** Flow file under `packages/mobile/.maestro/showcase/`, run while recording. */
  flow: string;
  /**
   * Seconds dropped from the head of the raw recording when the recorder cannot
   * see the flow's first step start (see `resolveTrimSeconds`). Maestro needs
   * 6-7 s to attach, and the recording starts before it does.
   */
  trimSeconds: number;
  /** Callouts the scene draws on this take; the app must log each at least once. */
  expectedAnchors: readonly ShowcaseAnchorName[];
  /** Footage the scene needs, from `requiredTakeSeconds`. */
  minSeconds: number;
  /** The wall the take must be on; checked against the app's `[screenshot] board[N]` log. */
  board: Readonly<{ slot: number; kind: ShowcaseBoardKind }> | null;
  /** Needs the fake-BLE bundle (`EXPO_PUBLIC_SCREENSHOT_FAKE_BLE=1`). */
  fakeBle: boolean;
  /**
   * The crew take's second phone: signs in as a second account, opens
   * ://join/<sessionId> and runs `joinFlow`, then runs `flow` beside the
   * primary's recording.
   */
  secondary: Readonly<{ joinFlow: string; flow: string }> | null;
  /**
   * Flows run on the primary before recording, in order. The crew take uses
   * these to start a private live session and copy its invite link.
   */
  setupFlows: readonly string[];
  /** Flows run on the primary after recording (and on abort) to undo setup. */
  teardownFlows: readonly string[];
}>;

/** The callouts a take's scene draws. A scene with several takes draws none. */
export function expectedAnchorsFor(takeId: ShowcaseTakeId): readonly ShowcaseAnchorName[] {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
  if (!scene || scene.takes.length !== 1) return [];
  return scene.callouts;
}

function take(
  entry: Omit<ShowcaseTake, 'role' | 'expectedAnchors' | 'minSeconds' | 'secondary' | 'setupFlows' | 'teardownFlows'> &
    Partial<Pick<ShowcaseTake, 'secondary' | 'setupFlows' | 'teardownFlows'>>,
): ShowcaseTake {
  return {
    role: 'primary',
    secondary: null,
    setupFlows: [],
    teardownFlows: [],
    ...entry,
    expectedAnchors: expectedAnchorsFor(entry.id),
    minSeconds: requiredTakeSeconds(entry.id),
  };
}

const boardTake = (id: ShowcaseTakeId, slot: number): ShowcaseTake =>
  take({
    id,
    summary: `A lit climb on the ${SHOWCASE_BOARD_SLOTS[slot]} wall, held still.`,
    primeLinks: ['home', `climbs?screenshotOpenFirst=1&screenshotBoardIndex=${slot}`],
    flow: 'boards.yaml',
    trimSeconds: 6,
    board: { slot, kind: SHOWCASE_BOARD_SLOTS[slot] },
    fakeBle: false,
  });

export const SHOWCASE_TAKES: readonly ShowcaseTake[] = [
  take({
    id: 'light',
    summary: 'Open the first climb, tap the bulb (fake board: "On the wall"), swipe to the next climb twice.',
    primeLinks: ['home', 'climbs?screenshotOpenFirst=1&screenshotBoardIndex=0'],
    flow: 'light.yaml',
    trimSeconds: 6,
    board: { slot: 0, kind: 'kilter' },
    fakeBle: true,
  }),
  boardTake('boards-kilter', 0),
  boardTake('boards-tension', 1),
  boardTake('boards-moonboard', 2),
  take({
    id: 'crew',
    summary: 'A private live session: invite QR, a second phone adds a climb, the row lands with their avatar.',
    // Open a climb first so the session has one playing (the now-playing bar
    // is how crew.yaml reaches the queue), then the pre-session Record tab. The
    // setup flows leave the invite sheet open, so recording starts on the QR.
    primeLinks: ['home', 'climbs?screenshotOpenFirst=1&screenshotBoardIndex=0', 'home', 'record'],
    flow: 'crew.yaml',
    trimSeconds: 6,
    board: { slot: 0, kind: 'kilter' },
    fakeBle: false,
    secondary: { joinFlow: 'crew-join.yaml', flow: 'crew-secondary.yaml' },
    setupFlows: ['crew-private.yaml', 'crew-start.yaml'],
    teardownFlows: ['crew-end.yaml'],
  }),
  take({
    id: 'log',
    summary: 'Profile progress with the activity calendar, filtered to one board and then another.',
    primeLinks: ['home', 'profile'],
    flow: 'log.yaml',
    trimSeconds: 6,
    board: null,
    fakeBle: false,
  }),
];

export function findShowcaseTake(takeId: ShowcaseTakeId): ShowcaseTake {
  const found = SHOWCASE_TAKES.find((candidate) => candidate.id === takeId);
  if (!found) throw new Error(`No showcase take "${takeId}"`);
  return found;
}

/** Every contract take has exactly one registry entry, in contract order. */
export function assertShowcaseTakesComplete(takes: readonly ShowcaseTake[] = SHOWCASE_TAKES): void {
  const ids = takes.map((entry) => entry.id);
  const missing = SHOWCASE_TAKE_IDS.filter((takeId) => !ids.includes(takeId));
  const duplicated = ids.filter((takeId, index) => ids.indexOf(takeId) !== index);
  if (missing.length > 0 || duplicated.length > 0) {
    throw new Error(
      `Showcase take registry is out of step with the contract (missing: ${missing.join(', ') || 'none'}; ` +
        `duplicated: ${duplicated.join(', ') || 'none'})`,
    );
  }
}

export const showcaseFlowPath = (flow: string): string => resolve(SHOWCASE_FLOW_DIR, flow);
