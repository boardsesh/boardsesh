/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Pins the triggers of partner-oauth-e2e.yml. The journey boots a backend and
 * `next dev`, so it must stay off every PR that does not touch partner OAuth,
 * and a red nightly must reach the deploy channel.
 */

type Step = { name?: string; run?: string };
type Job = { if?: string; needs?: string[]; environment?: string; steps?: Step[] };
type Workflow = {
  permissions?: Record<string, string>;
  on: { schedule?: Array<{ cron: string }>; pull_request?: { paths?: string[] }; workflow_dispatch?: unknown };
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, Job>;
};

const workflow = parse(readFileSync('.github/workflows/partner-oauth-e2e.yml', 'utf8')) as Workflow;

describe('partner-oauth-e2e.yml', () => {
  it('runs nightly off the hour and half hour, and not on the Expo-web smoke slot', () => {
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    const [minute, hour] = (workflow.on.schedule?.[0]?.cron ?? '').split(' ').map(Number);
    expect([0, 30]).not.toContain(minute);
    expect(`${hour}:${minute}`).not.toBe('15:23');
  });

  it('runs on a pull request only for the listed partner OAuth paths', () => {
    expect(workflow.on.pull_request?.paths).toEqual([
      'packages/backend/src/auth/partner/**',
      'packages/backend/src/handlers/partner-*.ts',
      'packages/backend/src/handlers/public-api/**',
      'packages/backend/src/graphql/resolvers/oauth-clients/**',
      'packages/db/src/schema/auth/partner-oauth.ts',
      'packages/db/drizzle/*partner*',
      'packages/web/app/oauth/**',
      'packages/web/app/developers/**',
      'packages/web/app/lib/partner-oauth/**',
      'packages/web/app/components/account/connected-apps-section.tsx',
      'packages/shared/auth-protocol/src/partner-oauth*',
      'packages/web/partner-oauth-e2e/**',
      'packages/web/playwright.partner-oauth.config.ts',
      '.github/workflows/partner-oauth-e2e.yml',
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

  it('runs the journey as the repo task', () => {
    const runs = (workflow.jobs['partner-oauth'].steps ?? []).map((step) => step.run ?? '');
    expect(runs).toContain('vp run test:e2e:partner-oauth');
  });

  it('cancels a superseded PR run but never a nightly or a dispatch', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('posts to Discord only for a red scheduled run, from a job that can read the webhook', () => {
    const notify = workflow.jobs['notify-nightly'];
    expect(notify.environment).toBe('Production');
    expect(notify.needs).toEqual(['partner-oauth']);
    expect(notify.if).toBe(
      "${{ always() && github.event_name == 'schedule' && needs.partner-oauth.result == 'failure' }}",
    );
    expect(workflow.jobs['partner-oauth'].environment).toBeUndefined();
  });
});
