// Whether the app may suggest taking a board offline, and where.
//
// Pure: no React, no AsyncStorage, no expo. Everything the decision needs is an
// argument, so the whole table is unit-testable and one place answers "why did
// (or didn't) this fire".
//
// Two kinds of surface, and the difference is the whole design:
//
//   Prompts (`post_session`) INTERRUPT. The user did not ask; the app spoke.
//   They carry a cooldown, a lifetime cap, a cross-surface cooldown and a
//   post-acceptance quiet period.
//
//   Affordances (`no_catalog`, `whats_new`, `board_card`, `onboarding`) live
//   inside a screen the user chose to look at, usually in place of a dead end.
//   Capping them is a regression: an empty state that reverts to "nothing here"
//   72 hours after an unrelated prompt is worse than the empty state we set out
//   to fix. They are bounded by eligibility and dismiss-forever alone.
//   `onboarding` is the extreme case — first run happens once, so it is capped
//   by construction and any frequency machinery could only ever silence it.

import type { BoardDownloadState } from '../../components/board-discovery/board-offline-state';

export type NudgeSurface = 'post_session' | 'no_catalog' | 'whats_new' | 'board_card' | 'onboarding';

export const NUDGE_SURFACES: readonly NudgeSurface[] = [
  'post_session',
  'no_catalog',
  'whats_new',
  'board_card',
  'onboarding',
];

/** Surfaces that interrupt, and therefore carry frequency machinery. */
const CAPPED_SURFACES: ReadonlySet<NudgeSurface> = new Set<NudgeSurface>(['post_session']);

export const POST_SESSION_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const POST_SESSION_MAX_SHOWS = 3;
/** No two interruptive prompts inside three days, whatever their surface. */
export const GLOBAL_PROMPT_COOLDOWN_MS = 72 * 60 * 60 * 1000;
/** Someone who just accepted does not need asking again this month. */
export const POST_ACCEPT_QUIET_MS = 30 * 24 * 60 * 60 * 1000;

export type NudgeSurfaceState = {
  lastShownAtMs: number | null;
  shownCount: number;
  dismissedForever: boolean;
};

export type OfflineNudgeState = {
  surfaces: Record<NudgeSurface, NudgeSurfaceState>;
  /** Most recent show of any CAPPED surface — drives the cross-surface cooldown. */
  lastPromptAtMs: number | null;
  /** Most recent accept of any surface. */
  lastAcceptedAtMs: number | null;
};

function emptySurfaceState(): NudgeSurfaceState {
  return { lastShownAtMs: null, shownCount: 0, dismissedForever: false };
}

export function emptyNudgeState(): OfflineNudgeState {
  return {
    surfaces: {
      post_session: emptySurfaceState(),
      no_catalog: emptySurfaceState(),
      whats_new: emptySurfaceState(),
      board_card: emptySurfaceState(),
      onboarding: emptySurfaceState(),
    },
    lastPromptAtMs: null,
    lastAcceptedAtMs: null,
  };
}

/** A state in which nothing will ever be shown. Used when storage can't be read. */
export function suppressedNudgeState(): OfflineNudgeState {
  const state = emptyNudgeState();
  for (const surface of NUDGE_SURFACES) {
    state.surfaces[surface] = { ...emptySurfaceState(), dismissedForever: true };
  }
  return state;
}

export type NudgeDecisionInput = {
  surface: NudgeSurface;
  state: OfflineNudgeState;
  nowMs: number;
  /** `useOfflineDownloadsEnabled()` — native/web platform availability. */
  offlineEngineEnabled: boolean;
  /**
   * The candidate board's download state, from `boardDownloadState()`. Anything
   * but `'off'` means the user already asked for this board — including
   * `'pending'`, which is exactly what an offline arm produces, so gating on
   * "not in downloadedScopeKeys" instead would re-prompt for a board the nudge
   * itself just armed.
   */
  offlineState: BoardDownloadState;
  /** `getSetting('autoOfflineBoards')` — this user downloads everything already. */
  autoOfflineBoards: boolean;
  /**
   * `post_session` only: a store-review prompt is actually going to appear on
   * this screen. Must be the resolved `shouldRequestSessionStoreReview` answer
   * (cooldown + per-session dedup + `StoreReview.hasAction()`), never the bare
   * `isSessionStoreReviewEligible` predicate — that one is just "≥3 sends", so
   * using it would silence the nudge on every good session, its whole audience.
   */
  storeReviewWillPrompt?: boolean;
};

/**
 * Screenshot runs must render the app, not our marketing. Every comparable
 * surface does this (`hasUnseenChangelog`, `hasSeenTip`, `OnboardingGate`), and
 * this flag is baked on for the App Store capture matrix.
 */
function isScreenshotMode(): boolean {
  return process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';
}

export function shouldShowNudge(input: NudgeDecisionInput): boolean {
  if (isScreenshotMode()) return false;
  if (!input.offlineEngineEnabled) return false;
  // The board is already downloaded, downloading, or armed — there is nothing
  // to suggest.
  if (input.offlineState !== 'off') return false;
  // This user opted into downloading every board they own; suggesting one is noise.
  if (input.autoOfflineBoards) return false;

  const surfaceState = input.state.surfaces[input.surface] ?? emptySurfaceState();
  if (surfaceState.dismissedForever) return false;

  if (!CAPPED_SURFACES.has(input.surface)) return true;

  if (input.storeReviewWillPrompt) return false;
  if (surfaceState.shownCount >= POST_SESSION_MAX_SHOWS) return false;
  if (surfaceState.lastShownAtMs !== null && input.nowMs - surfaceState.lastShownAtMs < POST_SESSION_COOLDOWN_MS) {
    return false;
  }
  if (input.state.lastPromptAtMs !== null && input.nowMs - input.state.lastPromptAtMs < GLOBAL_PROMPT_COOLDOWN_MS) {
    return false;
  }
  if (input.state.lastAcceptedAtMs !== null && input.nowMs - input.state.lastAcceptedAtMs < POST_ACCEPT_QUIET_MS) {
    return false;
  }
  return true;
}

function withSurface(
  state: OfflineNudgeState,
  surface: NudgeSurface,
  update: (previous: NudgeSurfaceState) => NudgeSurfaceState,
): OfflineNudgeState {
  const previous = state.surfaces[surface] ?? emptySurfaceState();
  return {
    ...state,
    surfaces: { ...state.surfaces, [surface]: update(previous) },
  };
}

export function withNudgeShown(state: OfflineNudgeState, surface: NudgeSurface, nowMs: number): OfflineNudgeState {
  const next = withSurface(state, surface, (previous) => ({
    ...previous,
    lastShownAtMs: nowMs,
    shownCount: previous.shownCount + 1,
  }));
  // Only interruptive prompts start the cross-surface cooldown; an affordance
  // the user scrolled past must not silence the next real prompt.
  return CAPPED_SURFACES.has(surface) ? { ...next, lastPromptAtMs: nowMs } : next;
}

export function withNudgeAccepted(state: OfflineNudgeState, surface: NudgeSurface, nowMs: number): OfflineNudgeState {
  return { ...withSurface(state, surface, (previous) => previous), lastAcceptedAtMs: nowMs };
}

export function withNudgeDismissed(
  state: OfflineNudgeState,
  surface: NudgeSurface,
  dismissKind: 'once' | 'forever',
  nowMs: number,
): OfflineNudgeState {
  return withSurface(state, surface, (previous) => ({
    ...previous,
    // A one-off dismissal is the cooldown doing its job, so record the moment
    // rather than a flag: the surface returns after its own cooldown, and an
    // uncapped affordance is unaffected by design.
    lastShownAtMs: nowMs,
    dismissedForever: dismissKind === 'forever' ? true : previous.dismissedForever,
  }));
}
