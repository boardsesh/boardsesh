/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import {
  buildGateJobInputs,
  computeGateVerdict,
  formatDuration,
  gateJobDurationSeconds,
  gateJobState,
  smokeDetail,
  type GateJobInput,
} from '../mobile-e2e-gate-verdict';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function job(id: string, mode: GateJobInput['mode'], result: string | undefined, detail = ''): GateJobInput {
  return { id, mode, result, detail, durationSeconds: 65 };
}

describe('computeGateVerdict', () => {
  it('passes when every blocking job passed', () => {
    const verdict = computeGateVerdict(
      [job('expo-web', 'blocking', 'success'), job('android-smoke', 'blocking', 'success')],
      SHA,
    );
    expect(verdict).toMatchObject({ passed: true, blockingFailed: false, anyRed: false });
    expect(verdict.line).toContain(`passed=true sha=${SHA} blocking 2/2 passed`);
  });

  it('fails the verdict when a blocking job failed', () => {
    const verdict = computeGateVerdict(
      [job('expo-web', 'blocking', 'success'), job('android-smoke', 'blocking', 'failure', 'native crash')],
      SHA,
    );
    expect(verdict).toMatchObject({ passed: false, blockingFailed: true, anyRed: true });
    expect(verdict.line).toContain('android-smoke=fail (native crash)');
  });

  it('reports an advisory failure without failing anything', () => {
    const verdict = computeGateVerdict(
      [job('expo-web', 'blocking', 'success'), job('ios-smoke', 'advisory', 'failure')],
      SHA,
    );
    expect(verdict).toMatchObject({ passed: true, blockingFailed: false, anyRed: true });
    expect(verdict.table).toContain('| ios-smoke | advisory | fail | 1 min 5 s |  |');
  });

  it('does not pass, and does not fail the job, when a blocking job was not run', () => {
    const verdict = computeGateVerdict(
      [job('boot-real-bytes', 'blocking', 'skipped', 'not implemented yet'), job('expo-web', 'blocking', 'success')],
      SHA,
    );
    expect(verdict).toMatchObject({ passed: false, blockingFailed: false, anyRed: false });
    expect(verdict.line).toContain('boot-real-bytes=not run (not implemented yet)');
  });

  it('treats a cancelled blocking job as a failure', () => {
    const verdict = computeGateVerdict([job('expo-web', 'blocking', 'cancelled')], SHA);
    expect(verdict).toMatchObject({ passed: false, blockingFailed: true, anyRed: true });
  });

  it('says so when nothing is blocking, where passed is vacuously true', () => {
    const verdict = computeGateVerdict(
      [job('boot-real-bytes', 'advisory', 'skipped'), job('expo-web', 'advisory', 'failure')],
      SHA,
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.line).toContain('blocking 0/0 passed (nothing is blocking yet, so this vouches for nothing)');
  });
});

describe('gateJobState', () => {
  it('never reads a skipped or missing job as a pass', () => {
    expect(gateJobState('success')).toBe('pass');
    expect(gateJobState('skipped')).toBe('not run');
    expect(gateJobState(undefined)).toBe('not run');
    expect(gateJobState('failure')).toBe('fail');
    expect(gateJobState('cancelled')).toBe('cancelled');
  });
});

describe('buildGateJobInputs', () => {
  const runJobs = [
    { name: 'resolve', started_at: '2026-10-06T00:00:00Z', completed_at: '2026-10-06T00:00:10Z' },
    { name: 'android-smoke', started_at: '2026-10-06T00:00:10Z', completed_at: '2026-10-06T00:20:40Z' },
    // A reusable workflow's jobs carry the calling job's id as a prefix.
    {
      name: 'expo-web / Typecheck (fail-fast)',
      started_at: '2026-10-06T00:00:10Z',
      completed_at: '2026-10-06T00:00:10Z',
    },
    { name: 'expo-web / Expo-web smoke', started_at: '2026-10-06T00:00:12Z', completed_at: '2026-10-06T00:06:34Z' },
    { name: 'ios-smoke', started_at: '2026-10-06T00:00:10Z', completed_at: null },
  ];

  it('keeps the map order, reads results from needs, and attaches notes and durations', () => {
    const inputs = buildGateJobInputs(
      { 'boot-real-bytes': 'advisory', 'expo-web': 'blocking', 'android-smoke': 'advisory' },
      {
        resolve: { result: 'success', outputs: { sha: SHA } },
        'boot-real-bytes': { result: 'skipped', outputs: {} },
        'expo-web': { result: 'success', outputs: {} },
        'android-smoke': {
          result: 'failure',
          outputs: { failure_class: 'no-content', failure_label: 'screen rendered no content' },
        },
      },
      runJobs,
      { 'boot-real-bytes': 'not implemented yet: see the real-bytes PR' },
    );
    expect(inputs.map((input) => input.id)).toEqual(['boot-real-bytes', 'expo-web', 'android-smoke']);
    expect(inputs[0]).toMatchObject({ result: 'skipped', detail: 'not implemented yet: see the real-bytes PR' });
    expect(inputs[1]).toMatchObject({ mode: 'blocking', durationSeconds: 384 });
    expect(inputs[2]).toMatchObject({ detail: 'screen rendered no content', durationSeconds: 1230 });
  });

  it('rejects a mode that is neither blocking nor advisory', () => {
    expect(() => buildGateJobInputs({ 'expo-web': 'required' }, {}, [])).toThrow(/"blocking" or "advisory"/);
  });

  it('finds a job under a caller prefix, and has no duration for one still running', () => {
    expect(
      gateJobDurationSeconds('android-smoke', [
        { name: 'gate / android-smoke', started_at: '2026-10-06T00:00:00Z', completed_at: '2026-10-06T00:01:00Z' },
      ]),
    ).toBe(60);
    expect(gateJobDurationSeconds('ios-smoke', runJobs)).toBeNull();
    expect(formatDuration(null)).toBe('n/a');
    expect(formatDuration(42)).toBe('42 s');
  });
});

describe('smokeDetail', () => {
  it('names the launch crash as its own countable class', () => {
    expect(
      smokeDetail({
        failure_class: 'native-crash-at-launch',
        failure_label: 'native crash at launch',
        native_crash_at_launch_count: '2',
      }),
    ).toBe('native crash at launch; x2');
  });

  it('still names it on a pass the retry recovered', () => {
    expect(smokeDetail({ failure_class: '', failure_label: '', native_crash_at_launch_count: '1' })).toBe(
      'native crash at launch x1, recovered by the fresh-boot retry',
    );
  });

  it('adds nothing to a clean pass', () => {
    expect(smokeDetail({ failure_class: '', failure_label: '', native_crash_at_launch_count: '0' })).toBe('');
    expect(smokeDetail({})).toBe('');
  });
});
