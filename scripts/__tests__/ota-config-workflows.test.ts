/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The three workflows that hold the xprem dashboard admin login through the
 * `ota-stable-release` environment. That login can remap the channel the whole
 * fleet is on, so the shape of these jobs is pinned and not left to review:
 * they run `main`'s code, install nothing, pin every action, and do nothing at
 * all when the environment has not been given the login.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const ADMIN_WORKFLOWS = ['ota-apply.yml', 'ota-drift.yml', 'mobile-ota-unlock.yml'] as const;

const readWorkflow = (name: string): string => readFileSync(join(WORKFLOWS_DIR, name), 'utf8');

/** The workflow without full-line comments, so prose about `--apply` is not read as a command. */
const withoutComments = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe.each(ADMIN_WORKFLOWS)('%s', (name) => {
  const source = readWorkflow(name);
  const code = withoutComments(source);

  it('pins every action to a commit SHA', () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action, action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it('gives its one job a timeout and the ota-stable-release environment', () => {
    expect(code.match(/^ {4}timeout-minutes: \d+$/gm)).toHaveLength(1);
    expect(code.match(/^ {4}environment: ota-stable-release$/gm)).toHaveLength(1);
    expect(code.match(/^ {4}runs-on: ubuntu-latest$/gm)).toHaveLength(1);
  });

  it('checks out main and nothing else', () => {
    expect(code.match(/uses: actions\/checkout@/g)).toHaveLength(1);
    expect(code).toMatch(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n {8}with:\n {10}ref: main\n/);
    expect(code).not.toContain('github.head_ref');
    expect(code).not.toContain('github.event.pull_request');
  });

  it('installs no dependencies while holding the admin login', () => {
    expect(code).not.toMatch(/\b(vp|pnpm|npm|yarn)\s+(install|ci|i|add|dlx|exec)\b/);
    expect(code).not.toContain('npx ');
    expect(code).not.toContain('setup-vp');
    expect(code).toContain('node --experimental-strip-types scripts/');
  });

  it('is a clear green no-op when the environment has no login', () => {
    const guard = code.indexOf('if [ -z "${OTA_ADMIN_EMAIL:-}" ] || [ -z "${OTA_ADMIN_PASSWORD:-}" ]; then');
    const firstNodeCall = code.indexOf('node --experimental-strip-types');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(firstNodeCall);
    const skip = code.slice(guard, firstNodeCall);
    expect(skip).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(skip).toContain('exit 0');
  });

  it('is never triggered by a pull request', () => {
    expect(code).not.toMatch(/^ {2}pull_request(_target)?:/m);
  });

  it('grants read-only repository access', () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read\n/m);
  });
});

describe('ota-apply.yml', () => {
  const code = withoutComments(readWorkflow('ota-apply.yml'));

  it('applies on a push to main that touches the declaration or the tool', () => {
    expect(code).toMatch(
      /push:\n {4}branches: \[main\]\n {4}paths:\n {6}- 'infra\/ota\/\*\*'\n {6}- 'scripts\/ota-apply\.ts'/,
    );
  });

  it('plans by default on a manual run, and applies only on a push or when asked', () => {
    expect(code).toMatch(/options:\n {10}- plan\n {10}- apply\n {8}default: plan/);
    expect(code).toContain("APPLY: ${{ github.event_name == 'push' || inputs.mode == 'apply' }}");
    expect(code).toContain('if [ "$APPLY" = "true" ]; then flags+=(--apply); fi');
  });
});

describe('ota-drift.yml', () => {
  const code = withoutComments(readWorkflow('ota-drift.yml'));

  it('runs daily, off the hour', () => {
    const cron = code.match(/cron: '(\d+) (\d+) \* \* \*'/);
    expect(cron).not.toBeNull();
    expect(Number(cron?.[1])).toBeGreaterThan(0);
  });

  it('never applies', () => {
    expect(code).not.toContain('--apply');
  });

  it('alerts Discord on drift and still fails the run', () => {
    expect(code).toContain('DISCORD_DEPLOY_WEBHOOK: ${{ secrets.DISCORD_DEPLOY_WEBHOOK }}');
    expect(code).toContain("if: steps.plan.outputs.result == 'drift'");
    expect(code).toContain('allowed_mentions: {parse: []}');
    expect(code.indexOf('Notify Discord')).toBeLessThan(code.indexOf('Fail the run on drift'));
  });
});

describe('mobile-ota-unlock.yml', () => {
  const code = withoutComments(readWorkflow('mobile-ota-unlock.yml'));

  it('is reusable and dispatchable', () => {
    expect(code).toMatch(/^ {2}workflow_call:/m);
    expect(code).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it('reverts, tolerates an idle branch, and can never finish a rollout', () => {
    expect(code).toContain('scripts/mobile-ota-rollout.ts revert');
    expect(code).toContain('--if-live');
    expect(code).not.toMatch(/mobile-ota-rollout\.ts\s+(finish|set)\b/);
  });

  it('passes inputs through the environment, never into the script text', () => {
    const runBlocks = code.split(/^ {8}run: \|$/m).slice(1);
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) expect(block).not.toContain('${{');
  });

  it('is not wired into any other workflow yet', () => {
    const callers = readdirSync(WORKFLOWS_DIR)
      .filter((file) => file !== 'mobile-ota-unlock.yml')
      .filter((file) => withoutComments(readWorkflow(file)).includes('mobile-ota-unlock'));
    expect(callers).toEqual([]);
  });
});

describe('release behaviour', () => {
  it('leaves every existing publish path on its defaults', () => {
    for (const name of ['production-deploy.yml', 'mobile-ota-production.yml', 'mobile-ota-backport.yml']) {
      const code = withoutComments(readWorkflow(name));
      expect(code, name).not.toContain('--rollout-percentage');
      expect(code, name).not.toContain('mobile-ota-rollout');
      expect(code, name).not.toContain('ota-apply');
      // The promote and the baseline capture still target the default branch.
      expect(code, name).not.toContain('pr-beta');
    }
  });
});
