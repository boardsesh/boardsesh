import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  if: string;
  'runs-on': string;
  needs?: string;
  environment?: string;
  concurrency?: { group: string; 'cancel-in-progress': boolean; queue: string };
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean; queue: string };
  jobs: Record<string, Job>;
}
const workflow = parse(readFileSync('.github/workflows/final-ios-screenshot-recovery.yml', 'utf8')) as Workflow;
const source = 'd5855045ff8170e4e72f9f2edfd1a2d5d396390d';

describe('frozen final screenshot recovery', () => {
  it('executes artifact and store security regressions in ordinary CI', () => {
    const result = spawnSync('python3', ['scripts/__tests__/final_ios_screenshot_recovery_test.py'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 7 tests');
  });

  it('limits dispatch to main, keeps capture secret-free, and serializes store publication', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['validate', 'capture', 'finalize']);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    }
    expect(JSON.stringify(workflow.jobs.capture)).not.toContain('secrets.');
    expect(workflow.jobs.finalize.if).toContain('inputs.upload');
    expect(workflow.jobs.finalize.environment).toBe('Production');
    expect(workflow.jobs.finalize.concurrency).toEqual({
      group: 'mobile-store-draft',
      'cancel-in-progress': false,
      queue: 'max',
    });
    expect(workflow.concurrency.group).toContain("inputs.phase == 'finalize' && 'mobile-screenshots-ios'");
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.queue).toBe('max');
    expect(workflow.jobs.capture.needs).toBe('validate');
    expect(workflow.jobs.finalize.needs).toBe('validate');
  });

  it('preserves historical app, capture tooling, env and strict action defaults on xlarge', () => {
    const original = parse(readFileSync('.github/workflows/mobile-screenshots-ios.yml', 'utf8')) as Workflow;
    const capture = workflow.jobs.capture;
    expect(capture['runs-on']).toBe('xcode-27-xlarge');
    expect(capture.env).toEqual(original.jobs['ios-capture'].env);
    const checkouts = capture.steps.filter((step) => step.uses === 'actions/checkout@v4');
    expect(checkouts[0].with?.ref).toBe(source);
    expect(checkouts[1].with?.ref).toBe(source);
    expect(checkouts[1].with?.path).toBe('.boardsesh/cache-tooling');
    const shard = capture.steps.find((step) => step.uses?.endsWith('/ios-screenshot-shard'));
    expect(shard?.with).toEqual({
      locale: 'de',
      'device-name': 'iPhone Duo',
      'device-slug': 'iphone-duo',
      flow: 'app-store',
      fixtures: 'replay',
      'app-cache-key':
        'macOS-ARM64-screenshot-sim-app-v2-Debug-27B52-27.2-24B8118-b24068e565a40dac5f688fd7c0316ebac49ef09d34fee203e2949c23c8380e9f',
    });
  });

  it('retains complete evidence after both unchanged gates and before any publication', () => {
    const steps = workflow.jobs.finalize.steps;
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    const retained = index('Retain complete images and manifest before publication');
    expect(index('Assert all screenshot dimensions')).toBeLessThan(retained);
    expect(index('Assert all screenshot content')).toBeLessThan(retained);
    const upload = index('Preflight, upload screenshots only, and verify complete readback');
    expect(retained).toBeLessThan(upload);
    const command = steps[upload].run ?? '';
    expect(command.indexOf('check-audit --audit')).toBeLessThan(command.indexOf('fastlane ios screenshots'));
    expect(command).toContain(
      '--manifest ../recovery-evidence/manifest.json --before ../recovery-evidence/preflight.json',
    );
    expect(command).not.toContain('surfaces:default');
    expect(command).toContain('fastlane ios screenshots || upload_status=$?');
    expect(command).toContain('[ "$upload_status" -eq 0 ] && [ "$readback_status" -eq 0 ]');
    expect(JSON.stringify(steps)).not.toMatch(/baseline -- publish|fastlane ios (upload|release|cpp|submit)/);
  });
  it('reads back partial upload failures without converting either failure into success', () => {
    const command = workflow.jobs.finalize.steps.find(
      (step) => step.name === 'Preflight, upload screenshots only, and verify complete readback',
    )?.run;
    if (!command) throw new Error('Missing publication script');
    const suffix = command.slice(command.indexOf('upload_status=0'));
    for (const [upload, audit, verify] of [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]) {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
        set -euo pipefail
        bundle() {
          echo "called:$*"
          if [ "$4" = screenshots ]; then return "$UPLOAD_RESULT"; fi
          return "$AUDIT_RESULT"
        }
        python3() { return "$VERIFY_RESULT"; }
        ${suffix}
      `,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: '/tmp',
            UPLOAD_RESULT: String(upload),
            AUDIT_RESULT: String(audit),
            VERIFY_RESULT: String(verify),
          },
        },
      );
      expect(result.stdout).toContain('called:exec fastlane ios audit');
      expect(result.status, result.stderr).toBe(upload || audit || verify ? 1 : 0);
    }
  });
});
