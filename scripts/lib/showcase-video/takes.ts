import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHOWCASE_ANCHOR_NAMES,
  SHOWCASE_TAKE_IDS,
  type ShowcaseAnchorName,
  type ShowcaseAnchorRect,
  type ShowcaseStaticAnchorName,
  type ShowcaseTakeId,
} from './contract';
import { SHOWCASE_SCENES, requiredTakeSeconds } from './timeline';

/**
 * How each take is captured: which deep link sets it up, which Maestro flow
 * drives it, and what the recorder checks afterwards. The recorder
 * (`scripts/showcase-video-record.ts`) reads nothing about a take from anywhere
 * else, so adding or changing a take starts here. See docs/showcase-video.md.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SHOWCASE_FLOW_DIR = resolve(REPO_ROOT, 'packages/mobile/.maestro/showcase');

export type ShowcaseBoardKind =
  | 'kilter'
  | 'tension'
  | 'moonboard'
  | 'woods'
  | 'decoy'
  | 'grasshopper'
  | 'touchstone'
  | 'soill';

/**
 * Walls reached by NAME, in `EXPO_PUBLIC_SCREENSHOT_BOARDS` slot order. The
 * recorder's `--boards` / `SHOWCASE_DEFAULT_BOARDS` lists one selector per slot.
 */
export const SHOWCASE_BOARD_SLOTS: readonly ShowcaseBoardKind[] = [
  'kilter',
  'tension',
  'moonboard',
  'woods',
  'decoy',
  'grasshopper',
];

/**
 * Board types the App Store account has no wall for. The take deep-links the
 * board CONFIG instead (`<board>/<layout>/<size>/<sets>/<angle>/list`), which the
 * app resolves through `resolveBoardForSession`: it reuses a matching board the
 * account already has, or adds one to the account's own boards list. So the
 * first run adds a board to the account, and every later run reuses it.
 */
export const SHOWCASE_BOARD_CONFIG_LINKS: Readonly<Partial<Record<ShowcaseBoardKind, string>>> = {
  touchstone: 'touchstone/1/1/1/40/list',
  soill: 'soill/1/2/1/40/list',
};

export type ShowcaseBackend = 'prod' | 'local';

/** A `setupFlows` entry that relaunches the app instead of running a flow. */
export const SHOWCASE_RELAUNCH_STEP = '@relaunch';

/** A lock-screen/island button rect the app cannot log, authored from a measured frame. */
export type ShowcaseStaticAnchor = Readonly<{
  name: ShowcaseStaticAnchorName;
  /** Points on the 440x956 iPhone 16 Pro Max screen. */
  rect: ShowcaseAnchorRect;
  /** The signal-server mark after which the rect is on screen (the flow raises it). */
  fromMark: string;
}>;

export type ShowcaseTake = Readonly<{
  id: ShowcaseTakeId;
  /** One line for the run log and the runbook. */
  summary: string;
  /**
   * Routes (after `com.boardsesh.app://`) opened in order on a freshly launched
   * app BEFORE recording starts, so the deep-link dialog and the screen's first
   * load stay out of the footage.
   */
  primeLinks: readonly string[];
  /** Flow file under `packages/mobile/.maestro/showcase/`, run while recording. */
  flow: string;
  /**
   * Seconds dropped from the head of the raw recording when the flow's
   * `flow-start` mark never arrives (see `resolveTrimSeconds`).
   */
  trimSeconds: number;
  /** App anchors the take must log: the scene's app callouts plus `extraAnchors`. */
  expectedAnchors: readonly ShowcaseAnchorName[];
  /** Lock-screen / island buttons, written into the anchors file by the recorder. */
  staticAnchors: readonly ShowcaseStaticAnchor[];
  /** Footage the scene needs, from `requiredTakeSeconds`. */
  minSeconds: number;
  /**
   * The wall the take must be on. `slot` is checked against the app's
   * `[screenshot] board[N]` log; a `null` slot (a deep-linked board config) is
   * checked against its `Board Route Handoff` resolving.
   */
  board: Readonly<{ slot: number | null; kind: ShowcaseBoardKind }> | null;
  /**
   * Starts a live session. The recorder first runs `session-private.yaml` and
   * refuses to go on unless the app logged "Show this session live" going OFF,
   * and ends any session the take started with `teardownFlows`, also on abort.
   */
  privateSession: boolean;
  /**
   * The crew take's second phone: signs in as a second account, opens
   * ://join/<sessionId> and runs `joinFlow`, then runs `flow` beside the
   * primary's recording.
   */
  secondary: Readonly<{ joinFlow: string; flow: string }> | null;
  /**
   * Flows run on the primary before recording, in order (after the
   * private-session switch). `SHOWCASE_RELAUNCH_STEP` relaunches the app there.
   */
  setupFlows: readonly string[];
  /** Flows run on the primary after recording (and on abort) to end the session. */
  teardownFlows: readonly string[];
  /** Why the take cannot be recorded on a backend; the recorder skips it and says so. */
  unavailable: Readonly<Partial<Record<ShowcaseBackend, string>>>;
}>;

const isAppAnchor = (name: string): name is ShowcaseAnchorName =>
  (SHOWCASE_ANCHOR_NAMES as readonly string[]).includes(name);

/**
 * App anchors a take must log: the app-logged callouts its scene draws (a
 * scene with several takes draws none), plus any the take adds for the
 * renderer's own use.
 */
export function expectedAnchorsFor(
  takeId: ShowcaseTakeId,
  extraAnchors: readonly ShowcaseAnchorName[] = [],
): readonly ShowcaseAnchorName[] {
  const scene = SHOWCASE_SCENES.find((candidate) => candidate.takes.includes(takeId));
  const fromScene = scene && scene.takes.length === 1 ? scene.callouts.filter(isAppAnchor) : [];
  return [...new Set([...fromScene, ...extraAnchors])];
}

type TakeInput = Omit<
  ShowcaseTake,
  | 'expectedAnchors'
  | 'minSeconds'
  | 'secondary'
  | 'setupFlows'
  | 'teardownFlows'
  | 'staticAnchors'
  | 'privateSession'
  | 'unavailable'
> &
  Partial<
    Pick<
      ShowcaseTake,
      'secondary' | 'setupFlows' | 'teardownFlows' | 'staticAnchors' | 'privateSession' | 'unavailable'
    >
  > & { extraAnchors?: readonly ShowcaseAnchorName[] };

function take({ extraAnchors, ...entry }: TakeInput): ShowcaseTake {
  const privateSession = entry.privateSession ?? false;
  return {
    secondary: null,
    setupFlows: [],
    staticAnchors: [],
    unavailable: {},
    ...entry,
    privateSession,
    teardownFlows: entry.teardownFlows ?? (privateSession ? ['session-end.yaml'] : []),
    expectedAnchors: expectedAnchorsFor(entry.id, extraAnchors),
    minSeconds: requiredTakeSeconds(entry.id),
  };
}

const NO_LOCAL_WALL = 'the dev DB has no wall of this type; record it against prod';

const boardTake = (id: ShowcaseTakeId, kind: ShowcaseBoardKind): ShowcaseTake => {
  const slot = SHOWCASE_BOARD_SLOTS.indexOf(kind);
  const configLink = SHOWCASE_BOARD_CONFIG_LINKS[kind];
  if (slot === -1 && !configLink) throw new Error(`No way to reach a ${kind} wall`);
  return take({
    id,
    summary: `A lit climb on the ${kind} wall, held still.`,
    primeLinks:
      slot === -1
        ? ['home', configLink as string, 'home', 'climbs?screenshotOpenFirst=1']
        : ['home', `climbs?screenshotOpenFirst=1&screenshotBoardIndex=${slot}`],
    flow: 'boards.yaml',
    trimSeconds: 6,
    board: { slot: slot === -1 ? null : slot, kind },
    unavailable: slot >= 3 ? { local: NO_LOCAL_WALL } : {},
  });
};

/** Open the first climb (so the session has one playing), then the pre-session Record tab. */
const sessionPrime = (slot: number): readonly string[] => [
  'home',
  `climbs?screenshotOpenFirst=1&screenshotBoardIndex=${slot}`,
  'home',
  'record',
];

export const SHOWCASE_TAKES: readonly ShowcaseTake[] = [
  take({
    id: 'light',
    summary: 'Open the first climb, tap the bulb (fake board: "On the wall"), swipe to the next climb twice.',
    primeLinks: ['home', 'climbs?screenshotOpenFirst=1&screenshotBoardIndex=0'],
    flow: 'light.yaml',
    trimSeconds: 6,
    board: { slot: 0, kind: 'kilter' },
  }),
  boardTake('boards-kilter', 'kilter'),
  boardTake('boards-tension', 'tension'),
  boardTake('boards-moonboard', 'moonboard'),
  boardTake('boards-woods', 'woods'),
  boardTake('boards-decoy', 'decoy'),
  boardTake('boards-touchstone', 'touchstone'),
  boardTake('boards-grasshopper', 'grasshopper'),
  boardTake('boards-soill', 'soill'),
  take({
    id: 'wall',
    summary: 'Climbs tab: tap the board button; the sheet shows what is on the wall now and what was lit before.',
    // screenshotBoardIndex=0 is a no-op switch that makes the app log which wall
    // slot 0 resolved to, for the wall check.
    primeLinks: ['home', 'climbs?screenshotBoardIndex=0'],
    flow: 'wall.yaml',
    trimSeconds: 6,
    board: { slot: 0, kind: 'kilter' },
  }),
  take({
    id: 'crew',
    summary: 'A private live session: invite QR, a second phone adds a climb, the row lands with their avatar.',
    // The setup flows leave the invite sheet open, so recording starts on the QR.
    primeLinks: sessionPrime(0),
    flow: 'crew.yaml',
    trimSeconds: 6,
    board: { slot: 0, kind: 'kilter' },
    privateSession: true,
    secondary: { joinFlow: 'crew-join.yaml', flow: 'crew-secondary.yaml' },
    setupFlows: ['crew-start.yaml'],
  }),
  take({
    id: 'workouts',
    summary: 'Record tab: pick Pyramid, see the generated preview, arm a fixed-window rest timer, start.',
    primeLinks: sessionPrime(0),
    flow: 'workouts.yaml',
    trimSeconds: 6,
    board: { slot: 0, kind: 'kilter' },
    privateSession: true,
    extraAnchors: ['workout-type', 'rest-timer'],
  }),
  take({
    id: 'lock-screen',
    summary: 'A live session on the wall; home screen, the Live Activity in the Dynamic Island, expand, Next.',
    // Tension: its Live Activity shows the Mirror button too.
    primeLinks: sessionPrime(1),
    flow: 'lock-screen.yaml',
    trimSeconds: 6,
    board: { slot: 1, kind: 'tension' },
    privateSession: true,
    setupFlows: ['lock-screen-setup.yaml', SHOWCASE_RELAUNCH_STEP, 'lock-screen-arm.yaml'],
    // Measured on a recorded frame of the expanded island (Tension: bulb, mirror, Next).
    staticAnchors: [
      { name: 'lock-relight', rect: { x: 176, y: 105, width: 36, height: 36 }, fromMark: 'island-expanded' },
      { name: 'lock-mirror', rect: { x: 228, y: 105, width: 36, height: 36 }, fromMark: 'island-expanded' },
      { name: 'lock-next', rect: { x: 300, y: 107, width: 60, height: 32 }, fromMark: 'island-expanded' },
    ],
  }),
  take({
    id: 'log',
    summary: 'Profile progress with the activity calendar, filtered to one board and then another.',
    primeLinks: ['home', 'profile'],
    flow: 'log.yaml',
    trimSeconds: 6,
    board: null,
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

export const isShowcaseFlow = (step: string): boolean => step !== SHOWCASE_RELAUNCH_STEP;

export const showcaseFlowPath = (flow: string): string => resolve(SHOWCASE_FLOW_DIR, flow);
