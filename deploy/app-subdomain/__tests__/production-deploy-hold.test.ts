import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the APP_WEB_DEPLOY_HOLD freeze on `deploy-app-web` in
// .github/workflows/production-deploy.yml — the job that ships this directory's
// Cloudflare Pages config (see ../README.md, docs/expo-web-deployment.md).
//
// deploy-web and deploy-production-backend read `check-rollback` and stage
// instead of promoting while a Vercel Instant Rollback is pinned. Pages exposes
// no equivalent signal, so a dashboard rollback of app.boardsesh.com is
// protected by this repo variable alone. Losing the gate fails silently and at
// the worst moment: the next merge touching packages/mobile re-ships the build
// the rollback was mitigating.
//
// It lives in this project, not scripts/, because it reads the workflow via fs.
// The `deploy-config` job in ci.yml runs this project UNFILTERED whenever
// production-deploy.yml changes; Vitest's `--changed` module-graph selection can
// never relate an fs read to a diff of the file it reads.

const WORKFLOW_PATH = resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'production-deploy.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

const HOLD_CLEAR = "vars.APP_WEB_DEPLOY_HOLD == ''";
const HOLD_SET = "vars.APP_WEB_DEPLOY_HOLD != ''";
const APP_CHANGED = "needs.detect-changes.outputs.app_changed == 'true'";

/**
 * The YAML body of a top-level job. Job keys sit at 2-space indent and their
 * bodies at 4+, so the block ends at the first line that is neither blank nor
 * 4-space indented — the next job key, or the comment introducing it.
 */
function jobBlock(jobId: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `  ${jobId}:`);
  if (start === -1) throw new Error(`production-deploy.yml has no \`${jobId}:\` job`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ')) break;
    body.push(line);
  }
  return body.join('\n');
}

/** The single-line job-level `if:` expression, or undefined. */
function jobCondition(jobId: string): string | undefined {
  return jobBlock(jobId).match(/^ {4}if: (.+)$/m)?.[1];
}

describe('production-deploy.yml: the app.boardsesh.com deploy hold', () => {
  it('skips deploy-app-web while APP_WEB_DEPLOY_HOLD is set', () => {
    const condition = jobCondition('deploy-app-web');
    expect(condition, 'deploy-app-web must carry a single-line job-level `if:`').toBeTruthy();
    expect(condition, 'the hold must gate the deploy').toContain(HOLD_CLEAR);
    expect(condition, 'and it must still only run when the app actually changed').toContain(APP_CHANGED);
  });

  it('gates the whole job, so no post-deploy check probes a deploy it withheld', () => {
    // The wrangler upload, the curl smoke and the Playwright boot check all live
    // in deploy-app-web. A step-level guard would leave the two checks asserting
    // against app.boardsesh.com for a build this run deliberately did not ship.
    const deployJob = jobBlock('deploy-app-web');
    expect(deployJob).toContain('--project-name=boardsesh-app');
    expect(deployJob).toContain('pages deploy');
    expect(
      (workflow.match(/pages deploy/g) ?? []).length,
      'exactly one Cloudflare Pages publish, and it must sit inside the gated job',
    ).toBe(1);
  });

  it('announces every held run on Discord', () => {
    // A skipped job is only grey in the run summary, so without the ping a
    // forgotten hold strands the browser app on an old bundle unnoticed.
    const notifyJob = jobBlock('notify-app-web-held');
    expect(jobCondition('notify-app-web-held')).toContain(HOLD_SET);
    expect(notifyJob).toContain('DISCORD_DEPLOY_WEBHOOK');
    expect(notifyJob, 'the message must name the variable to clear').toContain('APP_WEB_DEPLOY_HOLD');
  });

  it('pairs the gate and the ping on one condition, so neither can drift', () => {
    // The two `if:`s differ in exactly one operator: every run the hold skips is
    // a run the ping announces. Editing one alone opens a silent hole (held and
    // unannounced) or double-fires (deployed and announced as held).
    expect(jobCondition('deploy-app-web')?.replace(HOLD_CLEAR, HOLD_SET)).toBe(jobCondition('notify-app-web-held'));
  });

  it('reports a hold in the success notification instead of "unchanged"', () => {
    const successJob = jobBlock('notify-success');
    expect(successJob, 'notify-success must read the hold').toContain('APP_WEB_HELD:');
    expect(successJob, 'and print it rather than claiming the subdomain was unchanged').toContain(
      'held (APP_WEB_DEPLOY_HOLD set)',
    );
  });

  it('keeps the export env at workflow level, where mobile-ci-env-parity can see it', () => {
    // scripts/mobile-ci-env-parity.test.ts matches `^  KEY:` only, so moving
    // these into deploy-app-web blinds the test guarding them without failing
    // anything. That test is fs-read too, and `--changed` never selects it for a
    // workflow-only diff — this assertion runs in the deploy-config job, which
    // does fire on one.
    expect(jobBlock('deploy-app-web'), 'EXPO_PUBLIC_* must not be re-declared inside the job').not.toMatch(
      /^\s*EXPO_PUBLIC_[A-Z_]+:/m,
    );
    for (const key of ['EXPO_PUBLIC_SENTRY_DSN', 'EXPO_PUBLIC_POSTHOG_KEY', 'EXPO_PUBLIC_SENTRY_ENVIRONMENT']) {
      expect(workflow, `${key} must stay at workflow level (2-space indent)`).toMatch(new RegExp(`^ {2}${key}:`, 'm'));
    }
  });
});
