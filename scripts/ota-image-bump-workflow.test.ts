/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/ota-image-bump.yml'), 'utf8');

describe('OTA image bump workflow', () => {
  it('uses the repository App token for checkout, push, and pull requests', () => {
    expect(workflow).toContain('uses: actions/create-github-app-token@v1');
    expect(workflow).toContain('token: ${{ steps.push_token.outputs.token }}');
    expect(workflow).toContain('GH_TOKEN: ${{ steps.push_token.outputs.token }}');
    expect(workflow).not.toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('renders the PR body while the source still contains the previous version', () => {
    const bodyIndex = workflow.indexOf('--pr-body "$version"');
    const writeIndex = workflow.indexOf('--write "$version"');
    expect(bodyIndex).toBeGreaterThan(0);
    expect(bodyIndex).toBeLessThan(writeIndex);
  });

  it('keeps an identical open PR quiet but creates a PR for an orphan branch', () => {
    const identicalTreeGuard = workflow
      .split('\n')
      .find((line) => line.includes('HEAD^{tree}') && line.trimStart().startsWith('if '));
    expect(identicalTreeGuard).toContain('"$pr_state" = \'OPEN\'');
  });
});
