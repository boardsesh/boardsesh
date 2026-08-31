import { afterEach, describe, expect, it } from 'vitest';
import {
  GLOBAL_PROMPT_COOLDOWN_MS,
  POST_ACCEPT_QUIET_MS,
  POST_SESSION_COOLDOWN_MS,
  POST_SESSION_MAX_SHOWS,
  emptyNudgeState,
  shouldShowNudge,
  suppressedNudgeState,
  withNudgeAccepted,
  withNudgeDismissed,
  withNudgeShown,
  type NudgeDecisionInput,
  type NudgeSurface,
  type OfflineNudgeState,
} from '../nudge-policy';

const NOW = 1_800_000_000_000;

function input(overrides: Partial<NudgeDecisionInput> = {}): NudgeDecisionInput {
  return {
    surface: 'post_session',
    state: emptyNudgeState(),
    nowMs: NOW,
    offlineEngineEnabled: true,
    offlineState: 'off',
    autoOfflineBoards: false,
    ...overrides,
  };
}

const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
afterEach(() => {
  if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
});

describe('shouldShowNudge — eligibility', () => {
  it('shows on a board that is not offline at all', () => {
    expect(shouldShowNudge(input())).toBe(true);
  });

  // The self-retrigger regression: an offline accept leaves the scope 'pending',
  // which is NOT in downloadedScopeKeys and has no sync in flight, so a naive
  // gate would re-prompt for the board it just armed.
  it.each(['pending', 'downloading', 'downloaded'] as const)('suppresses when the board is %s', (offlineState) => {
    for (const surface of ['post_session', 'no_catalog', 'whats_new', 'board_card', 'onboarding'] as NudgeSurface[]) {
      expect(shouldShowNudge(input({ surface, offlineState }))).toBe(false);
    }
  });

  it('suppresses every surface when the user auto-downloads all boards', () => {
    for (const surface of ['post_session', 'no_catalog', 'whats_new', 'board_card', 'onboarding'] as NudgeSurface[]) {
      expect(shouldShowNudge(input({ surface, autoOfflineBoards: true }))).toBe(false);
    }
  });

  it('suppresses every surface in screenshot mode', () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    for (const surface of ['post_session', 'no_catalog', 'whats_new', 'board_card', 'onboarding'] as NudgeSurface[]) {
      expect(shouldShowNudge(input({ surface }))).toBe(false);
    }
  });

  it('suppresses when the offline engine is unavailable', () => {
    expect(shouldShowNudge(input({ offlineEngineEnabled: false }))).toBe(false);
  });

  it('respects dismiss-forever per surface', () => {
    const state = withNudgeDismissed(emptyNudgeState(), 'no_catalog', 'forever', NOW);
    expect(shouldShowNudge(input({ surface: 'no_catalog', state }))).toBe(false);
    expect(shouldShowNudge(input({ surface: 'whats_new', state }))).toBe(true);
  });

  it('suppresses everything from the storage-failure state', () => {
    const state = suppressedNudgeState();
    for (const surface of ['post_session', 'no_catalog', 'whats_new', 'board_card', 'onboarding'] as NudgeSurface[]) {
      expect(shouldShowNudge(input({ surface, state }))).toBe(false);
    }
  });
});

describe('shouldShowNudge — caps apply to the interruptive prompt only', () => {
  it('holds the post-session prompt for its cooldown', () => {
    const state = withNudgeShown(emptyNudgeState(), 'post_session', NOW);
    expect(shouldShowNudge(input({ state, nowMs: NOW + POST_SESSION_COOLDOWN_MS - 1 }))).toBe(false);
    // The global cooldown is shorter, so at the surface cooldown it is free again.
    expect(shouldShowNudge(input({ state, nowMs: NOW + POST_SESSION_COOLDOWN_MS }))).toBe(true);
  });

  it('stops after the lifetime cap', () => {
    let state = emptyNudgeState();
    let nowMs = NOW;
    for (let show = 0; show < POST_SESSION_MAX_SHOWS; show += 1) {
      expect(shouldShowNudge(input({ state, nowMs }))).toBe(true);
      state = withNudgeShown(state, 'post_session', nowMs);
      nowMs += POST_SESSION_COOLDOWN_MS;
    }
    expect(shouldShowNudge(input({ state, nowMs }))).toBe(false);
  });

  it('applies the cross-surface cooldown between prompts', () => {
    const state = { ...emptyNudgeState(), lastPromptAtMs: NOW };
    expect(shouldShowNudge(input({ state, nowMs: NOW + GLOBAL_PROMPT_COOLDOWN_MS - 1 }))).toBe(false);
    expect(shouldShowNudge(input({ state, nowMs: NOW + GLOBAL_PROMPT_COOLDOWN_MS }))).toBe(true);
  });

  it('goes quiet for a month after any acceptance', () => {
    const state = withNudgeAccepted(emptyNudgeState(), 'no_catalog', NOW);
    expect(shouldShowNudge(input({ state, nowMs: NOW + POST_ACCEPT_QUIET_MS - 1 }))).toBe(false);
    expect(shouldShowNudge(input({ state, nowMs: NOW + POST_ACCEPT_QUIET_MS }))).toBe(true);
  });

  // The affordance regression the design review flagged: an empty state that
  // reverts to a dead end because an unrelated prompt fired two days ago.
  // `onboarding` is in here for a stronger reason still — first run happens
  // once, so a cooldown could only ever mean the offer is never made at all.
  it.each(['no_catalog', 'whats_new', 'board_card', 'onboarding'] as NudgeSurface[])(
    'never cools down the %s affordance',
    (surface) => {
      let state: OfflineNudgeState = { ...emptyNudgeState(), lastPromptAtMs: NOW, lastAcceptedAtMs: NOW };
      for (let show = 0; show < POST_SESSION_MAX_SHOWS + 3; show += 1) {
        expect(shouldShowNudge(input({ surface, state, nowMs: NOW + show }))).toBe(true);
        state = withNudgeShown(state, surface, NOW + show);
      }
      state = withNudgeDismissed(state, surface, 'once', NOW);
      expect(shouldShowNudge(input({ surface, state, nowMs: NOW + 1 }))).toBe(true);
    },
  );

  it('yields to a store-review prompt that is actually going to appear', () => {
    expect(shouldShowNudge(input({ storeReviewWillPrompt: true }))).toBe(false);
    // ...and NOT to the bare "≥3 sends" eligibility, which is on for the whole
    // audience this prompt is written for.
    expect(shouldShowNudge(input({ storeReviewWillPrompt: false }))).toBe(true);
  });
});

describe('nudge state reducers', () => {
  it('does not mutate the input state', () => {
    const state = emptyNudgeState();
    const snapshot = JSON.stringify(state);
    withNudgeShown(state, 'post_session', NOW);
    withNudgeAccepted(state, 'post_session', NOW);
    withNudgeDismissed(state, 'post_session', 'forever', NOW);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('counts shows and starts the cross-surface cooldown for prompts only', () => {
    const prompted = withNudgeShown(emptyNudgeState(), 'post_session', NOW);
    expect(prompted.surfaces.post_session.shownCount).toBe(1);
    expect(prompted.lastPromptAtMs).toBe(NOW);

    const affordance = withNudgeShown(emptyNudgeState(), 'board_card', NOW);
    expect(affordance.surfaces.board_card.shownCount).toBe(1);
    expect(affordance.lastPromptAtMs).toBeNull();
  });
});
