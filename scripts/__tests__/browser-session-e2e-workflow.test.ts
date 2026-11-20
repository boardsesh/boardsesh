/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Pins the triggers and shape of browser-session-e2e.yml (#7596, B7a). The
 * harness builds an Expo export and boots a backend and `next dev`, so it must
 * stay off every PR that does not touch it or the auth it exercises, run both
 * engines, and keep its traces off and its cap at 30 minutes.
 */

type Step = { name?: string; if?: string; run?: string; with?: Record<string, string>; env?: Record<string, string> };
type Job = { if?: string; needs?: string[]; environment?: string; 'timeout-minutes'?: number; steps?: Step[] };
type Workflow = {
  permissions?: Record<string, string>;
  on: {
    schedule?: Array<{ cron: string }>;
    pull_request?: { paths?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { type?: string; options?: string[]; default?: string }> };
  };
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, Job>;
};

const workflow = parse(readFileSync('.github/workflows/browser-session-e2e.yml', 'utf8')) as Workflow;
const playwrightConfig = readFileSync('packages/web/e2e/browser-session/playwright.config.ts', 'utf8');
const harnessScript = readFileSync('scripts/browser-session-e2e.ts', 'utf8');

describe('browser-session-e2e.yml', () => {
  it('runs nightly off the hour and half hour, and off the other e2e slots', () => {
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    const [minute, hour] = (workflow.on.schedule?.[0]?.cron ?? '').split(' ').map(Number);
    expect([0, 30]).not.toContain(minute);
    expect(`${hour}:${minute}`).not.toBe('15:23');
    expect(`${hour}:${minute}`).not.toBe('16:47');
  });

  it('runs on a pull request only for the harness and the auth it exercises', () => {
    expect(workflow.on.pull_request?.paths).toEqual([
      'packages/web/e2e/browser-session/**',
      'scripts/browser-session-e2e.ts',
      'packages/web/partner-oauth-e2e/edge.ts',
      'packages/web/partner-oauth-e2e/server-environment.ts',
      'packages/web/auth-proofs/apple-oidc-fixture.ts',
      'packages/web/auth-proofs/google-oidc-fixture.ts',
      'packages/web/instrumentation.ts',
      'packages/web/app/lib/auth/**',
      'packages/web/app/api/auth/**',
      'packages/web/app/api/internal/ws-auth/**',
      'packages/backend/src/auth/**',
      'packages/shared/auth-protocol/src/**',
      'packages/mobile/src/lib/auth*.web.ts',
      'packages/mobile/src/**/user-storage-owner.web.ts',
      'packages/mobile/src/lib/graphql/use-auth-token.web.ts',
      '.github/workflows/browser-session-e2e.yml',
    ]);
  });

  it('lists only paths that still exist, so a rename fails here instead of never triggering', () => {
    for (const path of workflow.on.pull_request?.paths ?? []) {
      const prefix = path.split('*')[0];
      const target = prefix.endsWith('/') ? prefix : dirname(prefix);
      expect(existsSync(prefix.endsWith('/') || !path.includes('*') ? prefix : target), path).toBe(true);
      if (path.includes('*') && !prefix.endsWith('/')) {
        const matches = readdirSync(target).filter((name) => name.startsWith(basename(prefix)));
        expect(matches.length, path).toBeGreaterThan(0);
      }
    }
  });

  it('asks for read-only repository access', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('caps the job at 60 minutes and installs both engines, each install attempt bounded', () => {
    const job = workflow.jobs['browser-session'];
    expect(job['timeout-minutes']).toBe(60);
    const runs = (job.steps ?? []).map((step) => step.run ?? '');
    const install = runs.find((run) => run.includes('playwright install'));
    expect(install).toContain('timeout 600 vp exec playwright install --with-deps chromium webkit');
    expect(install).toContain('for attempt in 1 2 3');
    expect(runs).toContain('vp run test:e2e:browser-session');
  });

  it('runs every CI run against a production www build, and lets a dispatch choose next dev', () => {
    const runs = (workflow.jobs['browser-session'].steps ?? []).filter(
      (step) => step.run === 'vp run test:e2e:browser-session',
    );
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.env?.BROWSER_SESSION_E2E_WWW).toBe("${{ inputs.www || 'production' }}");
    expect(workflow.on.workflow_dispatch?.inputs?.www).toMatchObject({
      type: 'choice',
      options: ['production', 'dev'],
      default: 'production',
    });
  });

  it('runs the legacy baseline off pull requests, then the acceptance specs under better-auth on every run', () => {
    const [legacy, acceptance] = (workflow.jobs['browser-session'].steps ?? []).filter(
      (step) => step.run === 'vp run test:e2e:browser-session',
    );
    expect(legacy?.if).toBe("github.event_name != 'pull_request'");
    expect(legacy?.env?.AUTH_BROWSER_SESSION_MODE).toBeUndefined();
    expect(acceptance?.if).toBeUndefined();
    expect(acceptance?.env?.AUTH_BROWSER_SESSION_MODE).toBe('better-auth');
    expect(acceptance?.env?.BROWSER_SESSION_E2E_REUSE_EXPORT).toBe('1');
    // Green, the whole set fits a pull request's budget (#7810): no subset.
    expect(acceptance?.env?.BROWSER_SESSION_E2E_GREP).toBeUndefined();
  });

  it('cancels a superseded PR run but never a nightly or a dispatch', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('posts to Discord only for a red scheduled run, from a job that can read the webhook', () => {
    const notify = workflow.jobs['notify-nightly'];
    expect(notify.environment).toBe('Production');
    expect(notify.needs).toEqual(['browser-session']);
    expect(notify.if).toBe(
      "${{ always() && github.event_name == 'schedule' && needs.browser-session.result == 'failure' }}",
    );
    expect(workflow.jobs['browser-session'].environment).toBeUndefined();
  });
});

describe('the browser-session harness', () => {
  it('retries a spec only after WebKit lost its context: three named harness retries, and a run past two fails', () => {
    expect(playwrightConfig).toContain('retries: 0,');
    // The one test-level retry: WebKit only, and the reporter refuses it after any other failure.
    expect(playwrightConfig).toContain("{ name: 'webkit', retries: 1,");
    expect(playwrightConfig).toContain("['./harness-retry-reporter.ts']");
    const retries = readFileSync('packages/web/e2e/browser-session/harness-retries.ts', 'utf8');
    expect(retries).toContain("'restart-www-timeout' | 'webkit-internal-error' | 'webkit-network-process-lost'");
    expect(retries).toContain('MAX_HARNESS_RETRIES = 2');
  });

  it('runs Chromium and WebKit, with traces off in CI', () => {
    expect(playwrightConfig).toContain("name: 'chromium'");
    expect(playwrightConfig).toContain("name: 'webkit'");
    expect(playwrightConfig).toContain("trace: process.env.CI ? 'off'");
  });

  it('builds the standalone export and never lets a caller edit /etc/hosts', () => {
    expect(harnessScript).toContain("'--subdomain'");
    expect(harnessScript).not.toContain('/etc/hosts');
  });

  it('probes the back/forward cache in a project that turns it on, and no other', () => {
    expect(playwrightConfig).toContain("name: 'chromium-bfcache'");
    expect(playwrightConfig).toContain("ignoreDefaultArgs: ['--disable-back-forward-cache']");
    expect(playwrightConfig.match(/ignoreDefaultArgs/g)).toHaveLength(1);
  });

  it('sweeps stale run directories and offers a production www build', () => {
    const globalSetup = readFileSync('packages/web/e2e/browser-session/global-setup.ts', 'utf8');
    expect(globalSetup).toContain('sweepStaleRunDirectories(runsDirectory)');
    expect(globalSetup).toContain("BROWSER_SESSION_E2E_WWW ?? 'dev'");
    expect(harnessScript).toContain('--www-production');
  });

  it('keeps the base spec in legacy mode and the main suite out of the harness', () => {
    expect(readFileSync('packages/web/e2e/browser-session/legacy-mode.spec.ts', 'utf8')).toContain(
      'AUTH_BROWSER_SESSION_MODE',
    );
    expect(readFileSync('packages/web/playwright.config.ts', 'utf8')).toContain("'**/browser-session/**'");
  });
});
