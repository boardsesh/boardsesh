import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const BOARD_WEBP_INPUT = 'packages/web/public/images/**/*.webp';
const RESOURCE_PLUGIN_INPUT = 'packages/mobile/plugins/with-board-art-resources.js';

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('native board-art workflow inputs', () => {
  const triggeredWorkflows = [
    'mobile-ota-check.yml',
    'mobile-ota-preview.yml',
    'mobile-ota-production.yml',
    'ios-testflight-rn.yml',
    'android-apk-rn.yml',
    'android-apk-dev-client.yml',
    'android-pr-rn.yml',
    'ios-rn-ci.yml',
  ];

  it.each(triggeredWorkflows)('%s reacts to board WebPs and the resource plugin', (workflowName) => {
    const workflow = readRepoFile(`.github/workflows/${workflowName}`);
    expect(workflow).toContain(BOARD_WEBP_INPUT);
    expect(workflow).toContain(RESOURCE_PLUGIN_INPUT);
  });

  it.each(['mobile-screenshots-ios.yml', 'mobile-screenshots-android.yml'])(
    '%s wrapper cache keys include board WebPs and plugin inputs',
    (workflowName) => {
      const workflow = readRepoFile(`.github/workflows/${workflowName}`);
      expect(workflow).toContain(BOARD_WEBP_INPUT);
      expect(workflow).toContain('packages/mobile/plugins/**');
    },
  );

  it('the shared Android build cache includes the packaged board-art inputs', () => {
    const action = readRepoFile('.github/actions/android-rn-setup/action.yml');
    expect(action).toContain(BOARD_WEBP_INPUT);
    expect(action).toContain(RESOURCE_PLUGIN_INPUT);
  });
});
