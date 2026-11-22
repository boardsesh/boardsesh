/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { 'runs-on': string; steps: Step[]; environment?: string }>;
};
const workflow = parse(readFileSync('.github/workflows/mobile-offline-write-qa.yml', 'utf8')) as Workflow;
const wrapper = readFileSync('scripts/ci-offline-write-qa.sh', 'utf8');

describe('native offline write QA delivery contract', () => {
  it('runs real native checks without a production environment or write token', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'pull_request']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.ios['runs-on']).toBe('xcode-27');
    for (const job of Object.values(workflow.jobs)) expect(job.environment).toBeUndefined();
    expect(wrapper).toContain('export EXPO_PUBLIC_OFFLINE_WRITE_QA=1');
    expect(wrapper).toContain('unset EXPO_PUBLIC_SCREENSHOT_MODE EXPO_PUBLIC_STORY_MODE');
  });

  it('requires fresh native Android inputs and validates the iOS cache identity', () => {
    const androidCommands = workflow.jobs.android.steps.map((step) => step.run ?? '').join('\n');
    expect(androidCommands).toContain('vp run mobile:android-apk -- --require-fresh');
    const iosCommands = workflow.jobs.ios.steps.map((step) => step.run ?? '').join('\n');
    expect(iosCommands).toContain('ios-screenshot-app-cache.ts validate');
    expect(iosCommands).toContain('--minimum-sdk 27.1');
    expect(iosCommands).toContain('xcrun simctl create');
    expect(iosCommands).not.toContain('simctl erase');
  });

  it('writes QA notes before Metro and never clears app storage', () => {
    expect(wrapper.indexOf('cat > .boardsesh/qa-notes.md')).toBeLessThan(wrapper.indexOf('vp run dev:mobile'));
    expect(wrapper).toContain('[dev:mobile] QA notes:');
    expect(wrapper).toContain('vp exec tsx scripts/mobile-offline-write-qa.ts');
    expect(wrapper).not.toMatch(/pm clear|uninstall|simctl erase/);
  });

  it('preserves receipts on green and red jobs', () => {
    for (const [platform, job] of Object.entries(workflow.jobs)) {
      const uploads = job.steps.filter((step) => step.uses === 'actions/upload-artifact@v4');
      expect(uploads).toHaveLength(1);
      expect(uploads[0].if).toBe('always()');
      expect(uploads[0].with).toMatchObject({
        path: `.boardsesh/offline-write-qa/${platform}/**`,
        'retention-days': 30,
      });
    }
  });
});
