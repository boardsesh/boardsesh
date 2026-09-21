import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_EVENTS } from '@boardsesh/analytics';

const trackMock = vi.hoisted(() => vi.fn());
// Stands in for the platform fork: native reports, the Expo browser build does not.
const reportingCtrl = vi.hoisted(() => ({ reports: true }));
const storage = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failReads: false,
}));

vi.mock('../../analytics', () => ({ track: trackMock }));
vi.mock('../../launch-gate-reporting', () => ({
  get REPORTS_LAUNCH_GATE_EVALUATIONS() {
    return reportingCtrl.reports;
  },
}));
vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => {
    if (storage.failReads) throw new Error('storage unavailable before first unlock');
    return storage.values.get(key) ?? null;
  },
  setPreference: async (key: string, value: unknown) => {
    storage.values.set(key, value);
  },
}));

const { reportBoardLookStepEvaluationOnce } = await import('../board-look-step-evaluation-log');

beforeEach(() => {
  trackMock.mockClear();
  storage.values.clear();
  storage.failReads = false;
  reportingCtrl.reports = true;
});

describe('reportBoardLookStepEvaluationOnce', () => {
  it('reports a climber who would get the step as would_present', async () => {
    await reportBoardLookStepEvaluationOnce('never_asked');
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.BoardLookStepEvaluated, {
      outcome: 'would_present',
      reason: 'never_asked',
    });
  });

  it('reports the settled skips as skipped', async () => {
    await reportBoardLookStepEvaluationOnce('look_chosen');
    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.BoardLookStepEvaluated, {
      outcome: 'skipped',
      reason: 'look_chosen',
    });
  });

  it('reports once per device, across launches', async () => {
    await reportBoardLookStepEvaluationOnce('never_asked');
    await reportBoardLookStepEvaluationOnce('never_asked');
    await reportBoardLookStepEvaluationOnce('step_seen');
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('keeps its one report for a verdict about the climber, not the launch', async () => {
    await reportBoardLookStepEvaluationOnce('launched_by_url');
    await reportBoardLookStepEvaluationOnce('blocked_segment');
    expect(trackMock).not.toHaveBeenCalled();

    await reportBoardLookStepEvaluationOnce('never_asked');
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the marker cannot be read', async () => {
    storage.failReads = true;
    await reportBoardLookStepEvaluationOnce('never_asked');
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('reports nothing from the Expo browser build, and leaves the marker unspent', async () => {
    // In a browser every launch reads as a deep link, so only `look_chosen`
    // could ever settle there and the would_present share would skew low.
    reportingCtrl.reports = false;
    await reportBoardLookStepEvaluationOnce('look_chosen');
    expect(trackMock).not.toHaveBeenCalled();
    expect(storage.values.has('boardLookStepEvaluationLogged')).toBe(false);
  });
});
