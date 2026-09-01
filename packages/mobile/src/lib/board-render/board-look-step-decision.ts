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
 * Order matters. The cheap, synchronous `none`s come FIRST so a climber who will
 * never see this step pays for neither the capability probe (two native renders)
 * nor the example-climb query. That ordering is also what lets a gate run this
 * twice — once optimistically with stand-ins for the async inputs, then again
 * for real — and trust the first pass to rule itself out.
 */
export function decideBoardLookStep(input: BoardLookStepInput): BoardLookStepDecision {
  if (!input.ready) return 'wait';
  // Store captures must reach the app, not our onboarding.
  if (input.screenshotMode) return 'none';

  if (!input.settingsLoaded) return 'wait';
  // They have already answered this question, in Settings or in a past step.
  if (input.storedMode !== 'default') return 'none';

  if (input.topSegment !== undefined && BOARD_LOOK_STEP_BLOCKED_TOP_SEGMENTS.has(input.topSegment)) return 'none';

  if (input.stepSeen === undefined) return 'wait';
  if (input.stepSeen) return 'none';

  // A custom-scheme link that resolves INTO a tab lands with segments[0] ===
  // '(tabs)', so the segment check above misses it; the cold-start launch URL is
  // the reliable signal that the climber has intent somewhere else.
  if (input.launchedByDeepLink) return 'none';

  // Nothing of the climber's own to draw. `loading` is "ask me again" — a fresh
  // install sits here until they pick a board — while `unavailable` is a board
  // that will not resolve this launch, and five identical unlit walls would
  // teach nothing about five drawings.
  if (input.previewStatus === 'loading') return 'wait';
  if (input.previewStatus === 'unavailable') return 'none';

  if (input.boardseshRendererAvailable === null) return 'wait';
  // This build cannot draw the thing being offered, so every Aura card
  // would be a classic render under someone else's name. The caller must NOT
  // mark the step seen in this case — the question is still worth asking once
  // they update.
  if (!input.boardseshRendererAvailable) return 'none';

  return 'show';
}
