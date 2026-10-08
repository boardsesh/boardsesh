import { describe, expect, it } from 'vitest';
import {
  decideStable,
  initialStableState,
  parseStableState,
  qualifyCandidate,
  refreshAfterOwnFinish,
} from './ota-stable';
import type { StableRelease } from './ota-stable';

import { candidateFixture, activeFixture, healthFixture, baselineIds } from '../__tests__/helpers/ota-stable-fixtures';

describe('daily release decisions', () => {
  it('starts only qualified candidates inside the daily window, once per day', () => {
    const state = { ...initialStableState(), candidate: candidateFixture() };
    expect(decideStable(state, new Date('2026-10-08T21:59:59Z'), []).action).toBe('hold');
    expect(decideStable(state, new Date('2026-10-08T22:00:00Z'), []).action).toBe('start');
    state.lastStartedDate = '2026-10-08';
    expect(decideStable(state, new Date('2026-10-08T22:37:00Z'), []).action).toBe('hold');
  });
  it.each(['missing', 'failed', 'cancelled', 'skipped'])(
    'rejects a %s blocking gate even with passed output',
    (result) => {
      const candidate = candidateFixture();
      const qualified = qualifyCandidate(candidate, {
        receipt: candidate.receipt,
        sha: candidate.receipt.commitHash,
        bootSha: candidate.receipt.commitHash,
        branch: 'pr-stable-candidate',
        smokeResult: result,
        bootResult: 'success',
        smokePassed: 'true',
        bootPassed: 'true',
      });
      expect(qualified.qaPassed).toBe(false);
      expect(
        decideStable({ ...initialStableState(), candidate: qualified }, new Date('2026-10-08T22:00:00Z'), []).action,
      ).toBe('hold');
    },
  );
  it('rejects a gate for different bytes, branch or either SHA', () => {
    const candidate = candidateFixture();
    const proof = {
      receipt: candidate.receipt,
      sha: candidate.receipt.commitHash,
      bootSha: candidate.receipt.commitHash,
      branch: 'pr-stable-candidate',
      smokeResult: 'success',
      bootResult: 'success',
      smokePassed: 'true',
      bootPassed: 'true',
    };
    for (const patch of [
      { branch: 'pr-staging' },
      { sha: 'f'.repeat(40) },
      { bootSha: 'f'.repeat(40) },
      {
        receipt: {
          ...candidate.receipt,
          platforms: {
            ...candidate.receipt.platforms,
            ios: { ...candidate.receipt.platforms.ios, bundleSha256: 'f'.repeat(64) },
          },
        },
      },
    ]) {
      expect(() => qualifyCandidate(candidate, { ...proof, ...patch })).toThrow('exact frozen');
    }
  });
  it('requires explicit true outputs from both gates', () => {
    const candidate = candidateFixture();
    expect(
      qualifyCandidate(candidate, {
        receipt: candidate.receipt,
        sha: candidate.receipt.commitHash,
        bootSha: candidate.receipt.commitHash,
        branch: 'pr-stable-candidate',
        smokeResult: 'success',
        bootResult: 'success',
        smokePassed: 'true',
        bootPassed: '',
      }).qaPassed,
    ).toBe(false);
  });
  it('delayed ticks move only one step and insufficient valid evidence ramps no further than 50%', () => {
    const active = activeFixture();
    const state = { ...initialStableState(), active };
    expect(decideStable(state, new Date('2026-10-09T12:00:00Z'), healthFixture('insufficient-evidence'))).toMatchObject(
      { action: 'raise', percentage: 10 },
    );
    active.percentage = 50;
    active.stepSince = '2026-10-09T10:00:00Z';
    expect(decideStable(state, new Date('2026-10-09T22:00:00Z'), healthFixture('insufficient-evidence')).action).toBe(
      'hold',
    );
  });
  it('waits four hours at each step', () => {
    const state = { ...initialStableState(), active: activeFixture() };
    expect(decideStable(state, new Date('2026-10-09T01:59:59Z'), healthFixture()).action).toBe('hold');
    expect(decideStable(state, new Date('2026-10-09T02:00:00Z'), healthFixture())).toMatchObject({
      action: 'raise',
      percentage: 10,
    });
  });
  it('finishes only in the daily window with twenty total and eight final-step hours', () => {
    const active = { ...activeFixture(), percentage: 50, stepSince: '2026-10-09T14:00:00Z' };
    const state = { ...initialStableState(), active };
    expect(decideStable(state, new Date('2026-10-09T21:59:59Z'), healthFixture()).action).toBe('hold');
    expect(decideStable(state, new Date('2026-10-09T22:00:00Z'), healthFixture()).action).toBe('finish');
    active.stepSince = '2026-10-09T14:01:00Z';
    expect(decideStable(state, new Date('2026-10-09T22:00:00Z'), healthFixture()).action).toBe('hold');
    active.stepSince = '2026-10-09T10:00:00Z';
    active.startedAt = '2026-10-09T03:00:00Z';
    expect(decideStable(state, new Date('2026-10-09T22:00:00Z'), healthFixture()).action).toBe('hold');
  });
  it('missing, malformed and one-platform health never progress', () => {
    const state = { ...initialStableState(), active: activeFixture() };
    const health = healthFixture();
    expect(decideStable(state, new Date('2026-10-09T08:00:00Z'), health.slice(0, 1)).action).toBe('hold');
    health[0].canary = null;
    expect(decideStable(state, new Date('2026-10-09T08:00:00Z'), health).action).toBe('hold');
    health[0].canary = { devicesOnUpdate: 1, successfulDevices: Number.NaN, faultyDevices: 0 };
    expect(decideStable(state, new Date('2026-10-09T08:00:00Z'), health).action).toBe('hold');
  });
  it('unhealthy evidence reverts even before the timer expires', () => {
    expect(
      decideStable(
        { ...initialStableState(), active: activeFixture() },
        new Date('2026-10-08T22:01:00Z'),
        healthFixture('unhealthy'),
      ).action,
    ).toBe('revert');
  });
  it('does not claim to revert a platform already finished to 100%', () => {
    const active: StableRelease = {
      ...activeFixture(),
      phase: 'finishing',
      completedPlatforms: { ios: baselineIds.ios },
    };
    expect(
      decideStable({ ...initialStableState(), active }, new Date('2026-10-09T22:00:00Z'), healthFixture('unhealthy')),
    ).toMatchObject({ action: 'hold', reason: expect.stringContaining('manual recovery') });
    active.completedPlatforms = {};
    const health = healthFixture('unhealthy');
    health[0].rollout.percentage = 100;
    expect(decideStable({ ...initialStableState(), active }, new Date('2026-10-09T22:00:00Z'), health).action).toBe(
      'hold',
    );
  });
  it('rejects expired and previously rejected candidates', () => {
    const state = { ...initialStableState(), candidate: candidateFixture() };
    expect(decideStable(state, new Date('2026-11-09T22:00:00Z'), []).action).toBe('hold');
    state.rejectedCommit = state.candidate.receipt.commitHash;
    expect(decideStable(state, new Date('2026-10-08T22:00:00Z'), []).action).toBe('hold');
  });
});
describe('checkpoint validation and baseline refresh', () => {
  it('round trips and rejects malformed ownership before a write', () => {
    const state = { ...initialStableState(), active: activeFixture() };
    expect(parseStableState(state)).toEqual(state);
    for (const patch of [
      { percentage: '5' },
      { updateIds: { ios: '31' } },
      { pendingPercentage: 100 },
      { completedPlatforms: { ios: baselineIds.ios } },
    ]) {
      expect(() => parseStableState({ ...state, active: { ...state.active, ...patch } })).toThrow();
    }
  });
  it('refreshes only the baseline this controller just replaced', () => {
    const candidate = candidateFixture();
    const active = activeFixture();
    const ids = { ios: '33333333-3333-3333-3333-333333333333', android: '44444444-4444-4444-4444-444444444444' };
    expect(refreshAfterOwnFinish(candidate, active, ids).receipt.baselineProductionUpdateIds).toEqual(ids);
    const changed = { ...candidate, receipt: { ...candidate.receipt, baselineProductionUpdateIds: ids } };
    expect(() => refreshAfterOwnFinish(changed, active, ids)).toThrow('independent');
  });
});
