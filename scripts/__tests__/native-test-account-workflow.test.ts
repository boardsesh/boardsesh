import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync('.github/workflows/recover-native-test-account.yml', 'utf8');
const workflow = parse(source) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<
    string,
    {
      if: string;
      environment: string;
      'timeout-minutes': number;
      env?: Record<string, string>;
      steps: Array<{
        name?: string;
        uses?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, string | number | boolean>;
      }>;
    }
  >;
};
const job = workflow.jobs['seal-test-account'];

describe('native test account workflow boundary', () => {
  it('allows only manual main dispatch with Production protection and no arbitrary inputs', () => {
    expect(workflow.on).toEqual({ workflow_dispatch: null });
    expect(Object.keys(workflow.jobs)).toEqual(['seal-test-account']);
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    expect(job.environment).toBe('Production');
    expect(job['timeout-minutes']).toBe(10);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('pins actions and checks out only the immutable dispatched commit without persisted credentials', () => {
    for (const step of job.steps.filter((entry) => entry.uses))
      expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    expect(job.steps[0].with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
  });

  it('passes exactly two account secrets only to the local sealing step after installation', () => {
    expect(job.env).toBeUndefined();
    const sealIndex = job.steps.findIndex((step) => step.name === 'Seal only the dedicated native test account');
    const installIndex = job.steps.findIndex((step) => step.name === 'Install dependencies');
    expect(installIndex).toBeLessThan(sealIndex);
    expect(job.steps[installIndex].run).toBe('vp install --frozen-lockfile');
    expect(job.steps[sealIndex].env).toEqual({
      SCREENSHOT_USER_EMAIL: '${{ secrets.SCREENSHOT_USER_EMAIL }}',
      SCREENSHOT_USER_PASSWORD: '${{ secrets.SCREENSHOT_USER_PASSWORD }}',
      NATIVE_TEST_ACCOUNT_OUTPUT: '${{ runner.temp }}/native-test-account.enc.json',
    });
    expect(source.match(/secrets\.[A-Z_]+/g)).toEqual([
      'secrets.SCREENSHOT_USER_EMAIL',
      'secrets.SCREENSHOT_USER_PASSWORD',
    ]);
    expect(job.steps[sealIndex].run).toBe('vp exec tsx scripts/seal-native-test-account.ts');
    for (const step of job.steps.filter((_, index) => index !== sealIndex)) expect(step.env).toBeUndefined();
  });

  it('uploads only the ciphertext path under the existing seven-day policy without publisher commands', () => {
    const upload = job.steps.find((step) => step.name === 'Upload encrypted test account handoff');
    expect(upload?.with).toEqual({
      name: 'native-test-account-${{ github.run_id }}',
      path: '${{ runner.temp }}/native-test-account.enc.json',
      'if-no-files-found': 'error',
      'retention-days': 7,
    });
    expect(job.steps.map((step) => step.run ?? '').join('\n')).not.toMatch(
      /\$\{\{|curl|echo|storage:|railway|expo|eoas|publish|printenv|set -x/,
    );
  });
});
