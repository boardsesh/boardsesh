import { DEEP_LINK_SEGMENTS } from '../deep-link-segments';
import type { BoardRenderModeSetting } from '../board-render-settings';
import type { BoardPreviewStatus } from '../../hooks/use-board-preview-climb';

/**
 * Whether to show the one-time "pick your board look" step, as one pure
 * function so every branch is unit-testable without a renderer.
 *
 * 2.4 makes the Aura drawing the app default. Changing how every climber's
 * board looks without asking is the thing this exists to avoid — but so is
 * interrupting someone who is busy, or asking a question whose answer this build
 * cannot honour. Hence the three-way result rather than a boolean.
 */

/**
 * Route groups the step must not cover, on top of the shared deep-link set.
 *
 * `qa` so the tester prompt is never displaced, and `play` so a restored player
 * is not covered. `boards` is already in `DEEP_LINK_SEGMENTS`, which is what
 * keeps the step off the board picker during the fresh-install handoff — it
 * fires on the way back instead.
 */
export const BOARD_LOOK_STEP_BLOCKED_TOP_SEGMENTS: ReadonlySet<string> = new Set([...DEEP_LINK_SEGMENTS, 'qa', 'play']);

export type BoardLookStepInput = {
  /** Auth + fonts resolved and the splash hidden. */
  ready: boolean;
  screenshotMode: boolean;
  /**
   * False while the AsyncStorage-backed render settings are still hydrating.
   *
   * Load-bearing: the unhydrated snapshot reports `mode: 'default'`, which is
   * exactly the value that qualifies a climber for this step. Reading
   * `storedMode` without checking this would ask EVERY climber, including the
   * ones who already chose Classic.
   */
  settingsLoaded: boolean;
  /** The STORED mode, not the effective one — only a never-chosen climber qualifies. */
  storedMode: BoardRenderModeSetting;
  /** `undefined` while the persisted flag is still being read. */
  stepSeen: boolean | undefined;
  /** The cold start came in through a deep link, so intent is elsewhere. */
  launchedByDeepLink: boolean;
  topSegment: string | undefined;
  /** `null` = the renderer capability probe has not answered yet. */
  boardseshRendererAvailable: boolean | null;
  previewStatus: BoardPreviewStatus;
};

/**
 * `wait` — not enough is known yet; ask again when the inputs change.
 * `none` — do nothing, this launch or ever.
 * `show` — present the step.
 */
export type BoardLookStepDecision = 'wait' | 'none' | 'show';

/**
 * Which rule produced the decision. The gate logs it while it evaluates without
 * presenting (#5654), so it names the input that decided, one reason per rule.
 */
export type BoardLookStepReason =
  | 'not_ready'
  | 'screenshot'
  | 'settings_loading'
  | 'look_chosen'
  | 'blocked_segment'
  | 'seen_pending'
  | 'step_seen'
  | 'launched_by_url'
  | 'preview_loading'
  | 'preview_unavailable'
  | 'renderer_pending'
  | 'renderer_unavailable'
  | 'never_asked';

export type BoardLookStepVerdict = { decision: BoardLookStepDecision; reason: BoardLookStepReason };

/**
 * The reasons that describe the climber rather than this launch: they would give
 * the same answer on the next launch too. A blocked route or a deep-link cold
 * start only says the step would sit this launch out, and every `wait` is by
 * definition not an answer yet.
 */
const SETTLED_REASONS: ReadonlySet<BoardLookStepReason> = new Set(['never_asked', 'look_chosen', 'step_seen']);

export function isSettledBoardLookReason(reason: BoardLookStepReason): boolean {
  return SETTLED_REASONS.has(reason);
}

/**
 * Order matters. The cheap, synchronous `none`s come FIRST so a climber who will
 * never see this step pays for neither the capability probe (two native renders)
 * nor the example-climb query. That ordering is also what lets a gate run this
 * twice — once optimistically with stand-ins for the async inputs, then again
 * for real — and trust the first pass to rule itself out.
 */
export function explainBoardLookStep(input: BoardLookStepInput): BoardLookStepVerdict {
  if (!input.ready) return { decision: 'wait', reason: 'not_ready' };
  // Store captures must reach the app, not our onboarding.
  if (input.screenshotMode) return { decision: 'none', reason: 'screenshot' };

  if (!input.settingsLoaded) return { decision: 'wait', reason: 'settings_loading' };
  // They have already answered this question, in Settings or in a past step.
  if (input.storedMode !== 'default') return { decision: 'none', reason: 'look_chosen' };

  if (input.topSegment !== undefined && BOARD_LOOK_STEP_BLOCKED_TOP_SEGMENTS.has(input.topSegment)) {
    return { decision: 'none', reason: 'blocked_segment' };
  }

  if (input.stepSeen === undefined) return { decision: 'wait', reason: 'seen_pending' };
  if (input.stepSeen) return { decision: 'none', reason: 'step_seen' };

  // A custom-scheme link that resolves INTO a tab lands with segments[0] ===
  // '(tabs)', so the segment check above misses it; the cold-start launch URL is
  // the reliable signal that the climber has intent somewhere else.
  if (input.launchedByDeepLink) return { decision: 'none', reason: 'launched_by_url' };

  // Nothing of the climber's own to draw. `loading` is "ask me again" — a fresh
  // install sits here until they pick a board — while `unavailable` is a board
  // that will not resolve this launch, and five identical unlit walls would
  // teach nothing about five drawings.
  if (input.previewStatus === 'loading') return { decision: 'wait', reason: 'preview_loading' };
  if (input.previewStatus === 'unavailable') return { decision: 'none', reason: 'preview_unavailable' };

  if (input.boardseshRendererAvailable === null) return { decision: 'wait', reason: 'renderer_pending' };
  // This build cannot draw the thing being offered, so every Aura card
  // would be a classic render under someone else's name. The caller must NOT
  // mark the step seen in this case — the question is still worth asking once
  // they update.
  if (!input.boardseshRendererAvailable) return { decision: 'none', reason: 'renderer_unavailable' };

  return { decision: 'show', reason: 'never_asked' };
}

export function decideBoardLookStep(input: BoardLookStepInput): BoardLookStepDecision {
  return explainBoardLookStep(input).decision;
}
