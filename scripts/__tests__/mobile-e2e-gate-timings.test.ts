import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildGateJobInputs, computeGateVerdict } from '../mobile-e2e-gate-verdict';

const workflow = parse(readFileSync('.github/workflows/mobile-e2e-gate.yml', 'utf8')) as {
  env: { GATE_JOBS: string };
  jobs: { verdict: { steps: Array<{ name?: string; run?: string }> } };
};
const timingsStep = workflow.jobs.verdict.steps.find((step) => step.name === 'Read job timings');
const recordedJob = {
  name: 'ios-smoke',
  started_at: '2026-11-16T19:00:00Z',
  completed_at: '2026-11-16T19:01:00Z',
};

function readTimings(exitCode: number) {
  if (!timingsStep?.run) throw new Error('Missing job timing step');
  const directory = mkdtempSync(join(tmpdir(), 'gate-timings-'));
  try {
    // Emit a valid first page even on failure, like a paginated request whose
    // later page is rate-limited. Execute the actual workflow shell and jq.
    const execution = spawnSync(
      'bash',
      ['-c', `gh() { printf '%s\\n' "$GH_RESPONSE"; return "$GH_EXIT"; }\n${timingsStep.run}`],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          RUNNER_TEMP: directory,
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          GH_RESPONSE: JSON.stringify(recordedJob),
          GH_EXIT: String(exitCode),
        },
      },
    );
    expect(execution.status, execution.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(directory, 'gate-run-jobs.json'), 'utf8')) as {
      jobs: Parameters<typeof buildGateJobInputs>[2];
    };
    return { jobs: report.jobs, stdout: execution.stdout };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('optional mobile gate timings', () => {
  it('keeps successful timing responses', () => {
    const { jobs, stdout } = readTimings(0);
    expect(jobs).toEqual([recordedJob]);
    expect(stdout).not.toContain('::warning::');
  });

  it.each([
    ['success', true, false],
    ['failure', false, true],
    ['cancelled', false, true],
    ['skipped', false, false],
  ] as const)('preserves the %s smoke verdict when the timing API fails', (result, passed, blockingFailed) => {
    const { jobs, stdout } = readTimings(1);
    expect(jobs).toEqual([]);
    expect(stdout).toContain('::warning::Cannot fetch optional job durations');
    const inputs = buildGateJobInputs(
      JSON.parse(workflow.env.GATE_JOBS) as Record<string, string>,
      {
        'expo-web': { result: 'success' },
        'android-smoke': { result: 'success' },
        'ios-smoke': { result },
      },
      jobs,
    );
    const verdict = computeGateVerdict(inputs, 'tested-commit');
    expect(verdict).toMatchObject({ passed, blockingFailed });
    expect(verdict.jobs.every((job) => job.durationSeconds === null)).toBe(true);
  });
});
