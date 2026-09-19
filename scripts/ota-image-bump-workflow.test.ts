/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/ota-image-bump.yml'), 'utf8');
const railwayWorkflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/railway-drift.yml'), 'utf8');

describe('OTA image bump workflow', () => {
  it('uses the repository App token for checkout, push, and pull requests', () => {
    expect(workflow).toContain('uses: actions/create-github-app-token@v1');
    expect(workflow).toContain('token: ${{ steps.push_token.outputs.token }}');
    expect(workflow).toContain('GH_TOKEN: ${{ steps.push_token.outputs.token }}');
    expect(workflow).not.toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  it('fails clearly when either App credential is missing without printing its value', () => {
    const credentialGuard = workflow.slice(
      workflow.indexOf('- name: Require the push credential'),
      workflow.indexOf('- name: Mint the push token'),
    );
    expect(credentialGuard).toContain('OTA_PUSH_APP_ID: ${{ vars.OTA_PUSH_APP_ID }}');
    expect(credentialGuard).toContain('OTA_PUSH_APP_PRIVATE_KEY: ${{ secrets.OTA_PUSH_APP_PRIVATE_KEY }}');
    expect(credentialGuard).toContain('if [ -z "$OTA_PUSH_APP_ID" ]');
    expect(credentialGuard).toContain('if [ -z "$OTA_PUSH_APP_PRIVATE_KEY" ]');
    expect(credentialGuard).toContain('::error::OTA_PUSH_APP_ID is not configured.');
    expect(credentialGuard).toContain('::error::OTA_PUSH_APP_PRIVATE_KEY is not configured.');
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

  it('distinguishes a missing branch and PR from lookup failures', () => {
    const executable = workflow
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(workflow).toContain('git show-ref --verify --hash "refs/remotes/origin/$branch"');
    expect(executable).not.toMatch(/git rev-parse[^\n]+\|\| true/);
    expect(workflow).toContain('gh pr list --head "$branch" --state all');
    expect(executable).not.toMatch(/gh pr view[^\n]+\|\| echo/);
  });
});

describe('Railway workflow', () => {
  it('validates rollback helper changes on pull requests', () => {
    const pullRequestPaths = railwayWorkflow.slice(
      railwayWorkflow.indexOf('  pull_request:'),
      railwayWorkflow.indexOf('\nconcurrency:'),
    );
    expect(pullRequestPaths).toContain("'scripts/railway-deployment-rollback.mjs'");
  });

  it('serializes manual diagnostics with push applies without cancellation', () => {
    expect(railwayWorkflow).toContain(
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && 'apply'",
    );
    expect(railwayWorkflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'schedule' || github.event_name == 'pull_request' }}",
    );
  });
});
