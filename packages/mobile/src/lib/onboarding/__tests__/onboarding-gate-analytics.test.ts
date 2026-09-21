import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { OnboardingGateEvaluation } from '../onboarding-gate-analytics';

const trackMock = vi.hoisted(() => vi.fn());
const updatesCtrl = vi.hoisted(() => ({ isEmbeddedLaunch: true }));
const clockCtrl = vi.hoisted(() => ({ nowMs: Date.parse('2026-09-21T12:30:00.000Z') }));

vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('expo-updates', () => ({
  get isEmbeddedLaunch() {
    return updatesCtrl.isEmbeddedLaunch;
  },
}));
vi.mock('../../clock', () => ({ nowMs: () => clockCtrl.nowMs }));

const { accountAgeHours, shouldReportOnboardingGate, trackOnboardingGateEvaluated } =
  await import('../onboarding-gate-analytics');

function evaluation(overrides: Partial<OnboardingGateEvaluation> = {}): OnboardingGateEvaluation {
  return {
    outcome: 'would_present',
    reason: 'no_board',
    step: 'intro',
    hadBoard: false,
    seenFlag: false,
    accountCreatedAt: '2026-09-20T12:00:00.000Z',
    trigger: 'remount',
    topSegment: '(tabs)',
    msSinceMount: 412.6,
    afterStall: false,
    ...overrides,
  };
}

beforeEach(() => {
  trackMock.mockClear();
  updatesCtrl.isEmbeddedLaunch = true;
});

describe('accountAgeHours', () => {
  const noon = Date.parse('2026-09-21T12:00:00.000Z');

  it('counts whole hours since the account was created', () => {
    expect(accountAgeHours('2026-09-21T09:59:00.000Z', noon)).toBe(2);
    expect(accountAgeHours('2026-09-14T12:00:00.000Z', noon)).toBe(168);
  });

  it('is null until the profile has loaded, or when the date does not parse', () => {
    expect(accountAgeHours(undefined, noon)).toBeNull();
    expect(accountAgeHours(null, noon)).toBeNull();
    expect(accountAgeHours('not a date', noon)).toBeNull();
  });

  it('never goes negative when the device clock runs behind the server', () => {
    expect(accountAgeHours('2026-09-21T13:00:00.000Z', noon)).toBe(0);
  });
});

describe('shouldReportOnboardingGate', () => {
  it('reports every would_present and every stall', () => {
    expect(shouldReportOnboardingGate(evaluation())).toBe(true);
    expect(
      shouldReportOnboardingGate(
        evaluation({ outcome: 'stalled', reason: 'not_ready', hadBoard: true, seenFlag: null }),
      ),
    ).toBe(true);
  });

  it("leaves out a returning climber's steady state", () => {
    expect(
      shouldReportOnboardingGate(
        evaluation({ outcome: 'skipped', reason: 'has_board', hadBoard: true, seenFlag: true }),
      ),
    ).toBe(false);
    // A deep-link launch of a climber with a board never read the flag; that is
    // still the steady state.
    expect(
      shouldReportOnboardingGate(
        evaluation({ outcome: 'skipped', reason: 'launched_by_url', hadBoard: true, seenFlag: null }),
      ),
    ).toBe(false);
  });

  it('still reports a board without the seen flag, the backfill case', () => {
    expect(
      shouldReportOnboardingGate(
        evaluation({ outcome: 'skipped', reason: 'has_board', hadBoard: true, seenFlag: false }),
      ),
    ).toBe(true);
  });

  it('reports every skip of a climber without a board', () => {
    expect(
      shouldReportOnboardingGate(
        evaluation({
          outcome: 'skipped',
          reason: 'deep_link_segment',
          hadBoard: false,
          seenFlag: null,
          topSegment: 'join',
        }),
      ),
    ).toBe(true);
  });

  it('leaves out the signed-out launch on the login screen', () => {
    expect(
      shouldReportOnboardingGate(
        evaluation({
          outcome: 'skipped',
          reason: 'deep_link_segment',
          hadBoard: false,
          seenFlag: null,
          topSegment: 'auth',
        }),
      ),
    ).toBe(false);
  });
});

describe('trackOnboardingGateEvaluated', () => {
  it('sends the documented snake_case payload', () => {
    trackOnboardingGateEvaluated(evaluation());

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OnboardingGateEvaluated, {
      outcome: 'would_present',
      reason: 'no_board',
      step: 'intro',
      had_board: false,
      seen_flag: false,
      account_age_hours: 24,
      ota_is_embedded: true,
      trigger: 'remount',
      top_segment: '(tabs)',
      ms_since_mount: 413,
      after_stall: false,
    });
  });

  it('marks a decision that landed after the watchdog had already reported a stall', () => {
    trackOnboardingGateEvaluated(evaluation({ afterStall: true }));
    expect(trackMock.mock.calls[0][1]).toMatchObject({ outcome: 'would_present', after_stall: true });
  });

  it('says whether this launch ran the JS embedded in the binary', () => {
    updatesCtrl.isEmbeddedLaunch = false;
    trackOnboardingGateEvaluated(evaluation());
    expect(trackMock.mock.calls[0][1]).toMatchObject({ ota_is_embedded: false });
  });

  it('sends null, not a guess, for what the gate did not know', () => {
    trackOnboardingGateEvaluated(
      evaluation({
        outcome: 'stalled',
        reason: 'board_unresolved',
        step: null,
        hadBoard: null,
        seenFlag: null,
        accountCreatedAt: undefined,
        topSegment: undefined,
      }),
    );
    expect(trackMock.mock.calls[0][1]).toMatchObject({
      had_board: null,
      seen_flag: null,
      account_age_hours: null,
      top_segment: null,
    });
  });

  it('sends nothing for a skip the volume rule leaves out', () => {
    trackOnboardingGateEvaluated(
      evaluation({ outcome: 'skipped', reason: 'has_board', hadBoard: true, seenFlag: true }),
    );
    expect(trackMock).not.toHaveBeenCalled();
  });
});
