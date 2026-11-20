/**
 * The player's swap look: how the stationary GPU board hands its lit holds from
 * one climb to the next on a binary that draws the native swap look (iOS and
 * Android, `swapLookVersion` 2). It is the board motion lab's I, "Ghost peek + standby",
 * on its Subtle preset, picked on an iPhone 13 Pro on 2026-11-18:
 *
 * - Dragging dims the old holds to 40% one by one from the edge the next climb
 *   comes from, pulling each glow in to a standby ring (reach down to 0.79×).
 *   Behind that front the next climb shows as glow-only halos, up to 40%.
 * - Letting go fills the halos in along the same sweep over 220 ms while the
 *   old rings go out by 150 ms; arriving halos swell by at most 5%.
 * - A commit within 400 ms of the previous one is a flick run: no halos, no
 *   drag dim, no swell, and a 140 ms swap. Shared holds never dip.
 *
 * Binaries without the look, Differentiate Without Color on iOS, and the
 * `player-swap-look-kill` switch use the base wall swap (`wall-swap.ts`).
 * Reduce Motion uses the base driver's linear dissolve. The native view
 * also turns the look off under either accessibility setting.
 *
 * To change the look, change `PLAYER_SWAP_LOOK`. The lab's I starts from it, so
 * the lab shows the player's look and its sliders retune it live
 * (docs/rendering/board-motion-lab.md).
 *
 * Pure and worklet-safe; `use-player-board-transition.ts` reads the switches.
 */
import type { BoardTransition } from './board-transition';
import { encodeSwapLook, SWAP_LOOK_NATIVE_VERSION } from './swap-look';
import { swapLookTransition, type SwapLookSpec } from './swap-look-driver';
import { WALL_SWAP, WALL_SWAP_SHARED_NATIVE_API } from './wall-swap';

/** The player's look: the lab's I on Subtle. */
export const PLAYER_SWAP_LOOK: SwapLookSpec = {
  // 150, not round 2's 120: the old rings linger 30 ms longer so a quick
  // re-flick never leaves the board darker than the shipped swap (see `look.ghost`).
  tuning: { ...WALL_SWAP, dimFloor: 0.4, durationMs: 220, outgoingEndMs: 150, incomingStartMs: 0 },
  look: {
    holdWindow: 0.25,
    lowWindow: 0.25,
    climbUp: false,
    jitter: 0,
    // Equal to the arrival floor, so an arriving climb's glow is never below its
    // weight and a ghost only holds its marks back. At round 2's 0.35 a climb
    // skipped by a quick re-flick faded out at 0.875× glow, and the board's
    // darkest moment after the re-flick fell below the shipped swap's (10.4 vs
    // 10.7 mean glow chroma in scripts/board-motion-preview, 1×).
    ghost: 0.4,
    markLag: 0.15,
    // perf-a11y R7a: 0.08 already fails the plateau 0.7 falloff; at most 0.06 ships.
    swell: 0.05,
    swellTail: 0.25,
    focus: 0,
    focusShape: 2,
    tighten: 0.35,
    topBoost: 0,
  },
  arrivalFloorShare: 1,
  sharedFloor: 1,
  runWindowMs: 400,
  runSwapMs: 140,
  ghostDrag: true,
  calmRuns: true,
};

/** Built once, so its identity never changes and the swap's UI-thread reaction is set up once. */
const PLAYER_SWAP_LOOK_TRANSITION: BoardTransition = swapLookTransition(PLAYER_SWAP_LOOK);

/**
 * The player's look as the board's `swapLook` prop encodes it. The wall
 * button's frost takes the same numbers, so its lights move with the board's
 * holds (`@boardsesh/frosted-bokeh` `swap.ts`); it reads them only for the
 * look's six-number frames.
 */
export const PLAYER_SWAP_LOOK_ENCODED: readonly number[] | undefined = PLAYER_SWAP_LOOK_TRANSITION.look
  ? encodeSwapLook(PLAYER_SWAP_LOOK_TRANSITION.look)
  : undefined;

/** What decides the player's transition: the binary's native constants and the two switches. */
export type PlayerSwapLookInputs = {
  /** `climbOverlayGpuApiVersion`. */
  apiVersion: number;
  /** `climbOverlaySwapCommandApi`: the look's seven-number frames go out as the swap command. */
  swapCommandApi: number;
  /** `climbOverlaySwapLookVersion`: 2 on iOS and Android binaries that draw the look, 0 on older ones. */
  swapLookVersion: number;
  /** `player-swap-look-kill` is on. */
  killed: boolean;
  /** The system's Reduce Motion. */
  reduceMotion: boolean;
  /** iOS Differentiate Without Color is on (not 'unknown': native turns the look off there as well). */
  differentiateWithoutColor: boolean;
};

/**
 * This binary draws the player's look: API 7's shared-hold weight, the swap
 * command and the native look. `GpuClimbOverlay` sends the look on the same
 * terms; on any other binary it would strip the frames to the shipped four
 * numbers, but with the look's timing, so the player must not ask.
 */
export function binaryDrawsPlayerSwapLook(
  apiVersion: number,
  swapCommandApi: number,
  swapLookVersion: number,
): boolean {
  return (
    apiVersion >= WALL_SWAP_SHARED_NATIVE_API && swapCommandApi >= 1 && swapLookVersion >= SWAP_LOOK_NATIVE_VERSION
  );
}

/**
 * The player's board transition: the look where the binary draws it and
 * nothing turned it off; absent everywhere else, which is the shipped wall swap.
 */
export function playerBoardTransition(inputs: PlayerSwapLookInputs): BoardTransition | undefined {
  if (inputs.killed || inputs.reduceMotion || inputs.differentiateWithoutColor) return undefined;
  return binaryDrawsPlayerSwapLook(inputs.apiVersion, inputs.swapCommandApi, inputs.swapLookVersion)
    ? PLAYER_SWAP_LOOK_TRANSITION
    : undefined;
}
