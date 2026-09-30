/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { jobBlocks, withoutCommentLines } from './helpers/workflow-yaml';

/**
 * Pins the trust-boundary properties of the `dispatch-homelab` job in
 * background-worker-image.yml (M0.1, plan "we-want-to-redesign-distributed-hippo"):
 * it must only ever fire on a push to main with the kill switch on, it must run
 * on a GitHub-hosted runner (never self-hosted -- the public repo carries no
 * homelab runner), and it must reference no secret beyond the one fine-grained
 * PAT it needs to dispatch to the private ansible repo.
 */

const WORKFLOW_PATH = '.github/workflows/background-worker-image.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

function dispatchHomelabBlock(): string[] {
  const block = jobBlocks(workflowSource).get('dispatch-homelab');
  if (!block) throw new Error('dispatch-homelab job not found in background-worker-image.yml');
  return block;
}

describe('background-worker-image.yml: dispatch-homelab job', () => {
  it('needs the image job', () => {
    const block = dispatchHomelabBlock();
    const needsLine = block.find((line) => line.trim().startsWith('needs:'));
    expect(needsLine, 'dispatch-homelab has no needs: line').toBeDefined();
    expect(needsLine).toContain('image');
  });

  it('runs only in the Homelab environment (never Production -- a reviewer/wait timer there would wedge the shared concurrency group)', () => {
    const block = dispatchHomelabBlock();
    expect(block.some((line) => line.trim() === 'environment: Homelab')).toBe(true);
  });

  it('gates on exactly a push event AND the HOMELAB_DEPLOY_ENABLED kill switch', () => {
    const block = dispatchHomelabBlock();
    const ifLine = block.find((line) => line.trim().startsWith('if:'));
    expect(ifLine, 'dispatch-homelab has no if: line').toBeDefined();
    // Pinned to the exact line, not a substring: a substring check stays green
    // even if `&&` silently became `||`, which would dispatch on every push
    // regardless of the kill switch.
    expect(ifLine?.trim()).toBe("if: github.event_name == 'push' && vars.HOMELAB_DEPLOY_ENABLED == 'true'");
  });

  it('runs on ubuntu-latest, never a self-hosted label', () => {
    const block = dispatchHomelabBlock();
    const runsOnLine = block.find((line) => line.trim().startsWith('runs-on:'));
    expect(runsOnLine, 'dispatch-homelab has no runs-on: line').toBeDefined();
    expect(runsOnLine).toContain('ubuntu-latest');
    expect(runsOnLine?.toLowerCase()).not.toContain('self-hosted');
  });

  it('carries no ambient permissions -- the step authenticates with its own PAT', () => {
    const block = dispatchHomelabBlock();
    expect(block.some((line) => line.trim() === 'permissions: {}')).toBe(true);
  });

  it('has a short timeout, since a hung dispatch call should not hold the job open', () => {
    const block = dispatchHomelabBlock();
    expect(block.some((line) => /^timeout-minutes:\s*5$/.test(line.trim()))).toBe(true);
  });

  it('references only secrets.HOMELAB_DISPATCH_TOKEN, no other secret', () => {
    const block = dispatchHomelabBlock();
    const joined = block.join('\n');
    const referencedSecrets = [...joined.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(referencedSecrets.length).toBeGreaterThan(0);
    expect(new Set(referencedSecrets)).toEqual(new Set(['HOMELAB_DISPATCH_TOKEN']));
  });

  it('validates the image digest against a strict sha256 regex before dispatching', () => {
    const block = dispatchHomelabBlock();
    expect(block.some((line) => line.includes('^sha256:[0-9a-f]{64}$'))).toBe(true);
  });

  it('never passes the dispatch token on argv -- it goes through curl --config on stdin', () => {
    const block = dispatchHomelabBlock();
    const joined = block.join('\n');
    // The token env var must never reach curl as a command-line argument, in
    // any of curl's equivalent forms for supplying a header or credential:
    // -H/--header, -u/--user, or --oauth2-bearer.
    expect(joined).not.toMatch(/-H\s+["']Authorization:.*HOMELAB_DISPATCH_TOKEN/);
    expect(joined).not.toMatch(/--header\s+["']Authorization:.*HOMELAB_DISPATCH_TOKEN/);
    expect(joined).not.toMatch(/(^|\s)-u\s+.*HOMELAB_DISPATCH_TOKEN/);
    expect(joined).not.toMatch(/--oauth2-bearer\s+.*HOMELAB_DISPATCH_TOKEN/);
    expect(joined).toContain('curl');
    expect(joined).toContain('--config -');
  });

  it('posts to the blackheathdc-ansible repository_dispatch endpoint', () => {
    const block = dispatchHomelabBlock();
    const joined = block.join('\n');
    expect(joined).toContain('repos/marcodejongh/blackheathdc-ansible/dispatches');
    expect(joined).toContain('boardsesh-worker-image');
  });
});

describe('background-worker-image.yml: image job exposes its digest', () => {
  it('declares a job-level digest output sourced from the build step', () => {
    const block = jobBlocks(workflowSource).get('image') ?? [];
    const joined = block.join('\n');
    expect(joined).toMatch(/digest:\s*\$\{\{\s*steps\.image\.outputs\.digest\s*\}\}/);
  });
});

describe('background-worker-image.yml: no self-hosted or pull_request_target exposure', () => {
  it('has no pull_request_target trigger anywhere in the workflow', () => {
    const lines = withoutCommentLines(workflowSource);
    expect(lines.some((line) => line.trim().startsWith('pull_request_target'))).toBe(false);
  });

  it('has no self-hosted runs-on anywhere in the workflow', () => {
    const lines = withoutCommentLines(workflowSource);
    const runsOnLines = lines.filter((line) => line.trim().startsWith('runs-on:'));
    expect(runsOnLines.length).toBeGreaterThan(0);
    for (const line of runsOnLines) {
      expect(line.toLowerCase()).not.toContain('self-hosted');
    }
  });
});
