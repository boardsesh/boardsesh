import { describe, expect, it } from 'vitest';
import {
  BOARD_LOOK_STEP_BLOCKED_TOP_SEGMENTS,
  decideBoardLookStep,
  explainBoardLookStep,
  isSettledBoardLookReason,
  type BoardLookStepInput,
} from '../board-look-step-decision';

/** A climber who qualifies on every axis — each case below spoils exactly one. */
function eligible(overrides: Partial<BoardLookStepInput> = {}): BoardLookStepInput {
  return {
    ready: true,
    screenshotMode: false,
    settingsLoaded: true,
    storedMode: 'default',
    stepSeen: false,
    launchedByDeepLink: false,
    topSegment: '(tabs)',
    boardseshRendererAvailable: true,
    previewStatus: 'ready',
    ...overrides,
  };
}

describe('decideBoardLookStep', () => {
  it('shows the step to a climber who has never chosen a mode', () => {
    expect(decideBoardLookStep(eligible())).toBe('show');
  });

  describe('waits rather than deciding on incomplete information', () => {
    it('waits until auth and fonts have resolved', () => {
      expect(decideBoardLookStep(eligible({ ready: false }))).toBe('wait');
    });

    it('waits while the render settings are still hydrating', () => {
      // The regression this pins: an unhydrated store reports `mode: 'default'`,
      // which is exactly what qualifies a climber. Deciding here would ask
      // EVERY climber, including the ones already on Classic.
      expect(decideBoardLookStep(eligible({ settingsLoaded: false, storedMode: 'default' }))).toBe('wait');
    });

    it('waits while the seen flag is still being read', () => {
      expect(decideBoardLookStep(eligible({ stepSeen: undefined }))).toBe('wait');
    });

    it('waits while the example climb is still loading', () => {
      expect(decideBoardLookStep(eligible({ previewStatus: 'loading' }))).toBe('wait');
    });

    it('waits while the renderer capability probe has not answered', () => {
      expect(decideBoardLookStep(eligible({ boardseshRendererAvailable: null }))).toBe('wait');
    });
  });

  describe('never shows', () => {
    it('in screenshot mode', () => {
      expect(decideBoardLookStep(eligible({ screenshotMode: true }))).toBe('none');
    });

    it('to a climber who already chose Classic', () => {
      expect(decideBoardLookStep(eligible({ storedMode: 'classic' }))).toBe('none');
    });

    it('to a climber who already chose Boardsesh', () => {
      expect(decideBoardLookStep(eligible({ storedMode: 'aura' }))).toBe('none');
    });

    it('once the step has been seen', () => {
      expect(decideBoardLookStep(eligible({ stepSeen: true }))).toBe('none');
    });

    it('over a deep-link cold start that landed inside the tabs', () => {
      expect(decideBoardLookStep(eligible({ launchedByDeepLink: true }))).toBe('none');
    });

    it.each([...BOARD_LOOK_STEP_BLOCKED_TOP_SEGMENTS])('over the %s route group', (segment) => {
      expect(decideBoardLookStep(eligible({ topSegment: segment }))).toBe('none');
    });

    it('when the climber has no board to preview', () => {
      expect(decideBoardLookStep(eligible({ previewStatus: 'unavailable' }))).toBe('none');
    });

    it('when the installed renderer cannot draw the Boardsesh mode', () => {
      // Every Boardsesh card would be a classic render under another name.
      expect(decideBoardLookStep(eligible({ boardseshRendererAvailable: false }))).toBe('none');
    });
  });

  describe('the fresh-install path', () => {
    it('holds at the board picker rather than firing over it', () => {
      // `boards` is in the shared deep-link set, so the handoff is protected.
      expect(decideBoardLookStep(eligible({ topSegment: 'boards' }))).toBe('none');
    });

    it('waits — not "never" — while a brand-new install has no board yet', () => {
      // The whole fresh-install sequence depends on this being `wait`: the step
      // has to still be pending when the climber comes back with a board bound.
      expect(decideBoardLookStep(eligible({ previewStatus: 'loading', topSegment: '(tabs)' }))).toBe('wait');
    });
  });

  describe('the optimistic preflight a gate runs before paying for the async reads', () => {
    // The gate calls this once with stand-ins for the values it has not read
    // yet, to rule the climber out cheaply. That is only sound if a `show` from
    // the optimistic pass can never hide a synchronous `none`.
    function preflight(overrides: Partial<BoardLookStepInput> = {}) {
      return decideBoardLookStep(
        eligible({ stepSeen: false, launchedByDeepLink: false, previewStatus: 'ready', ...overrides }),
      );
    }

    it.each([
      ['screenshot mode', { screenshotMode: true }],
      ['an explicit mode choice', { storedMode: 'classic' as const }],
      ['a blocked route', { topSegment: 'onboarding' }],
      ['an unusable renderer', { boardseshRendererAvailable: false }],
    ])('still rules out %s without any async read', (_label, overrides) => {
      expect(preflight(overrides)).toBe('none');
    });
  });
});

// The reason is what the gate logs while it evaluates without presenting
// (#5654), so each rule has to name itself, and the decision has to stay exactly
// what `decideBoardLookStep` returns.
describe('explainBoardLookStep', () => {
  it.each([
    ['never_asked', {}, 'show'],
    ['not_ready', { ready: false }, 'wait'],
    ['screenshot', { screenshotMode: true }, 'none'],
    ['settings_loading', { settingsLoaded: false }, 'wait'],
    ['look_chosen', { storedMode: 'classic' as const }, 'none'],
    ['blocked_segment', { topSegment: 'boards' }, 'none'],
    ['seen_pending', { stepSeen: undefined }, 'wait'],
    ['step_seen', { stepSeen: true }, 'none'],
    ['launched_by_url', { launchedByDeepLink: true }, 'none'],
    ['preview_loading', { previewStatus: 'loading' as const }, 'wait'],
    ['preview_unavailable', { previewStatus: 'unavailable' as const }, 'none'],
    ['renderer_pending', { boardseshRendererAvailable: null }, 'wait'],
    ['renderer_unavailable', { boardseshRendererAvailable: false }, 'none'],
  ] as const)('names %s', (reason, overrides, decision) => {
    const input = eligible(overrides);
    expect(explainBoardLookStep(input)).toEqual({ decision, reason });
    expect(decideBoardLookStep(input)).toBe(decision);
  });

  it('counts only the verdicts about the climber as settled', () => {
    expect(isSettledBoardLookReason('never_asked')).toBe(true);
    expect(isSettledBoardLookReason('look_chosen')).toBe(true);
    expect(isSettledBoardLookReason('step_seen')).toBe(true);
    expect(isSettledBoardLookReason('launched_by_url')).toBe(false);
    expect(isSettledBoardLookReason('blocked_segment')).toBe(false);
    expect(isSettledBoardLookReason('seen_pending')).toBe(false);
  });
});
