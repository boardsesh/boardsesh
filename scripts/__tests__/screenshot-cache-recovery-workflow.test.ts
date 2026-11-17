import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; needs?: string; steps: Step[] }>;
}
const workflow = parse(readFileSync('.github/workflows/mobile-screenshot-cache-recovery.yml', 'utf8')) as Workflow;
const capture = parse(readFileSync('.github/workflows/mobile-screenshots-ios.yml', 'utf8')) as Workflow;
const build = workflow.jobs['warm-cache'];
function script(name: string, steps = build.steps): string {
  const command = steps.find((step) => step.name === name)?.run;
  if (!command) throw new Error(`Missing command: ${name}`);
  return command;
}

describe('screenshot cache recovery', () => {
  it('permits only main dispatch and contains only validation and cache production', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.jobs)).toEqual(['validate-source', 'warm-cache']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    }
    expect(build.needs).toBe('validate-source');
    for (const checkout of build.steps.filter((step) => step.uses === 'actions/checkout@v4')) {
      expect(checkout.with?.ref).toBe('${{ needs.validate-source.outputs.source-sha }}');
      expect(checkout.with?.['persist-credentials']).toBe(false);
    }
  });

  it('executes the source guard against a real Git ancestry graph', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cache-recovery-test-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      git('commit', '--allow-empty', '-m', 'ancestor');
      const ancestor = git('rev-parse', 'HEAD');
      git('commit', '--allow-empty', '-m', 'main');
      const main = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', main);
      git('checkout', '-b', 'unmerged', ancestor);
      git('commit', '--allow-empty', '-m', 'unmerged');
      const unmerged = git('rev-parse', 'HEAD');
      const run = (sha: string) =>
        spawnSync('bash', ['-c', script('Validate historical main source', workflow.jobs['validate-source'].steps)], {
          cwd: directory,
          env: { ...process.env, REQUESTED_SOURCE_SHA: sha, GITHUB_OUTPUT: join(directory, 'output') },
          encoding: 'utf8',
        });
      expect(run(ancestor).status).toBe(0);
      expect(run(main).status).toBe(0);
      for (const invalid of [unmerged, 'f'.repeat(40), ancestor.slice(0, 7), 'main', '$(touch injected)']) {
        expect(run(invalid).status).not.toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a different or empty cache key before any restore, build or save', () => {
    const name = 'Require the exact requested cache key';
    const key = 'macOS-ARM64-screenshot-sim-app-v2-Debug-27B52-27.2-24B8118-' + 'b'.repeat(64);
    for (const expected of [key, '', key.replace('27B52', '27A9275')]) {
      const result = spawnSync('bash', ['-c', script(name)], {
        env: { ...process.env, EXPECTED_CACHE_KEY: expected, COMPUTED_CACHE_KEY: key },
        encoding: 'utf8',
      });
      expect(result.status === 0).toBe(expected === key);
    }
    const guard = build.steps.findIndex((step) => step.name === name);
    for (const stepName of [
      'Check for cached simulator app',
      'Build simulator dev-client app',
      'Save simulator app to cache',
    ]) {
      expect(build.steps.findIndex((step) => step.name === stepName)).toBeGreaterThan(guard);
    }
  });

  it('preserves the capture producer key, toolchain, build, validation and cache recipes', () => {
    for (const name of [
      'Select the screenshot build toolchain',
      'Compute app cache key',
      'Build simulator dev-client app',
      'Verify simulator app identity',
      'Save simulator app to cache',
    ]) {
      expect(build.steps.find((step) => step.name === name)).toEqual(
        capture.jobs['ios-build'].steps.find((step) => step.name === name),
      );
    }
  });
});
