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

/**
 * The shell body of a job's `run: |` step, with the surrounding YAML (the job's
 * own `if:`, its `env:` keys) stripped off. Assertions about what an operator
 * reads on Discord must run against this, not the whole job block: the block
 * quotes `APP_WEB_DEPLOY_HOLD` in the gate condition and the webhook name in
 * `env:`, so a whole-block `toContain` for either passes even after the message
 * and the POST are deleted.
 */
function jobRunScript(jobId: string): string {
  const block = jobBlock(jobId);
  const marker = block.indexOf('run: |');
  if (marker === -1) throw new Error(`production-deploy.yml's \`${jobId}:\` job has no \`run: |\` step`);
  return block.slice(marker + 'run: |'.length);
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
    expect(jobCondition('notify-app-web-held')).toContain(HOLD_SET);
    expect(jobBlock('notify-app-web-held'), 'the job must wire in the webhook secret').toContain(
      'DISCORD_DEPLOY_WEBHOOK: ${{ secrets.DISCORD_DEPLOY_WEBHOOK }}',
    );

    const notifyScript = jobRunScript('notify-app-web-held');
    expect(notifyScript, 'and the step must actually POST to it').toMatch(/curl[^\n]*"\$DISCORD_DEPLOY_WEBHOOK"/);
    expect(notifyScript, 'the posted message must tell the operator which variable to clear').toContain(
      'Clear the `APP_WEB_DEPLOY_HOLD` repo variable',
    );
  });

  it('pairs the gate and the ping on one condition, so neither can drift', () => {
    // The two `if:`s differ in exactly one operator: every run the hold skips is
    // a run the ping announces. Editing one alone opens a silent hole (held and
    // unannounced) or double-fires (deployed and announced as held).
    expect(jobCondition('deploy-app-web')?.replace(HOLD_CLEAR, HOLD_SET)).toBe(jobCondition('notify-app-web-held'));
  });

  it('reports a hold in the success notification instead of "unchanged"', () => {
    const heldEnv = jobBlock('notify-success').match(/^ +APP_WEB_HELD: (.+)$/m)?.[1];
    expect(heldEnv, 'notify-success must compute a held flag for the subdomain line').toBeTruthy();

    // Read off the observed outcome, never by re-reading the variable here.
    // notify-success declares `environment: Production`, so a step-level `vars.`
    // lookup resolves environment-scoped variables that the job-level gate on
    // deploy-app-web never sees — a hold scoped to the environment would then
    // print "held" for a deploy that actually shipped.
    expect(heldEnv, 'derive the hold from what deploy-app-web did').toContain(
      "needs.deploy-app-web.result == 'skipped'",
    );
    expect(heldEnv, 'and only claim a hold when this push would have deployed the subdomain').toContain(APP_CHANGED);
    expect(heldEnv, 'a step in an `environment:` job must not re-read the repo variable').not.toContain(
      'vars.APP_WEB_DEPLOY_HOLD',
    );

    // An `if`/`elif` chain, not two independent `if`s: an unconditional override
    // after the success branch prints "held" for a deploy that shipped.
    expect(jobRunScript('notify-success'), 'a successful deploy must win over the held line').toMatch(
      /if \[ "\$APP_WEB_RESULT" = "success" \]; then\s+APP_WEB_LINE="deployed"\s+elif \[ "\$APP_WEB_HELD" = "true" \]; then\s+APP_WEB_LINE="held \(APP_WEB_DEPLOY_HOLD set\)"/,
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
