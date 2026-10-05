/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADDITIVE_CHANGE_KINDS } from '../../infra/ota/plan';

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

  it('refuses any ref but main in its first step, before a secret is in scope', () => {
    const steps = code.slice(code.indexOf('    steps:\n'));
    const firstStep = steps.slice(0, steps.indexOf('\n      - ', steps.indexOf('      - ') + 1));
    expect(firstStep).toContain("if: github.ref != 'refs/heads/main'");
    expect(firstStep).toContain('exit 1');
    expect(firstStep).not.toContain('secrets.');
    expect(firstStep).not.toContain('env:');
  });

  it('does not claim the environment restricts itself', () => {
    // The environment does not exist until the owner creates it. Until then
    // nothing but the ref guard above keeps another branch out.
    expect(source).not.toMatch(/Restricted to `main`/);
    expect(source).toContain('deployment-branch policy of `main` BEFORE adding its secrets');
  });

  it('is a clear green no-op when the environment has no login', () => {
    const guard = code.indexOf('if [ -z "${OTA_ADMIN_EMAIL:-}" ] || [ -z "${OTA_ADMIN_PASSWORD:-}" ]; then');
    const firstAdminCall = code.search(/node --experimental-strip-types scripts\/(ota-apply|mobile-ota-rollout)\.ts/);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(firstAdminCall);
    const skip = code.slice(guard, firstAdminCall);
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

  it('is triggered by a push to main that touches the declaration, and by nothing else in the repo', () => {
    expect(code).toMatch(/push:\n {4}branches: \[main\]\n {4}paths:\n {6}- 'infra\/ota\/\*\*'\n {2}workflow_dispatch:/);
  });

  it('applies only the additive kinds on a push, through the script allowlist', () => {
    expect(code).toContain('if [ "$EVENT_NAME" = "push" ]; then');
    expect(code).toContain(`flags+=(--apply --only "${ADDITIVE_CHANGE_KINDS.join(',')}")`);
    // The only unrestricted apply is the one a person asked for.
    expect(code.match(/flags\+=\(--apply\)/g)).toHaveLength(1);
    expect(code).toMatch(/elif \[ "\$MODE" = "apply" \]; then\n\s+flags\+=\(--apply\)/);
  });

  it('plans by default on a manual run', () => {
    expect(code).toMatch(/options:\n {10}- plan\n {10}- apply\n {8}default: plan/);
  });

  it('never cancels a running apply', () => {
    expect(code).toMatch(/concurrency:\n {2}group: ota-config-apply\n {2}cancel-in-progress: false/);
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

  it('probes the admin API without a login, before the plan', () => {
    const probe = code.indexOf('scripts/ota-admin-api-probe.ts');
    const plan = code.indexOf('scripts/ota-apply.ts');
    expect(probe).toBeGreaterThan(0);
    expect(probe).toBeLessThan(plan);
    const probeStep = code.slice(code.indexOf('- name: Probe the admin API'), code.indexOf('- name: Plan against'));
    expect(probeStep).not.toContain('secrets.');
    expect(probeStep).not.toContain('OTA_ADMIN');
  });

  it('tells an unreadable server from a server that differs', () => {
    expect(code).toContain('2) echo "result=unreadable" >> "$GITHUB_OUTPUT" ;;');
    expect(code).toContain('*) echo "result=drift" >> "$GITHUB_OUTPUT" ;;');
    expect(code).toContain('**OTA config drift**');
    expect(code).toContain('**OTA server could not be read**');
    expect(code).toContain('**OTA admin API moved**');
    expect(code).toContain('This is not drift');
  });

  it('alerts Discord on a finding and still fails the run', () => {
    expect(code).toContain('DISCORD_DEPLOY_WEBHOOK: ${{ secrets.DISCORD_DEPLOY_WEBHOOK }}');
    expect(code).toContain('allowed_mentions: {parse: []}');
    expect(code.indexOf('Notify Discord')).toBeLessThan(code.indexOf('Fail the run on a finding'));
    const conditions = code.match(/if: >-\n(?: {10}.*\n){3}/g) ?? [];
    // The alert and the failure fire on exactly the same findings.
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toBe(conditions[1]);
  });
});

describe('mobile-ota-unlock.yml', () => {
  const code = withoutComments(readWorkflow('mobile-ota-unlock.yml'));

  it('is dispatch-only, so its steps always come from the ref it is started on', () => {
    expect(code).toMatch(/^ {2}workflow_dispatch:/m);
    expect(code).not.toContain('workflow_call');
  });

  it('takes both platforms runtime versions in one run', () => {
    expect(code).toMatch(/^ {6}ios_runtime_version:/m);
    expect(code).toMatch(/^ {6}android_runtime_version:/m);
    expect(code).toContain('for runtime_version in "$IOS_RUNTIME_VERSION" "$ANDROID_RUNTIME_VERSION"; do');
  });

  it('has no concurrency group, so a third request cannot cancel a waiting second', () => {
    expect(code).not.toMatch(/^concurrency:/m);
  });

  it('reverts, tolerates an idle branch, and can never finish a rollout', () => {
    expect(code).toContain('scripts/mobile-ota-rollout.ts revert');
    expect(code).toContain('--if-live');
    expect(code).not.toMatch(/mobile-ota-rollout\.ts\s+(finish|set)\b/);
  });

  it('passes inputs through the environment, never into the script text', () => {
    const runBlocks = code.split(/^ {8}run: \|$/m).slice(1);
    expect(runBlocks.length).toBeGreaterThan(0);
    // The last block ends the file; earlier ones are cut at the next step.
    for (const block of runBlocks) expect(block.split(/^ {6}- /m)[0]).not.toContain('${{');
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
