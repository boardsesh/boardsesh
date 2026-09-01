import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the two properties that make the gate useful and safe: it must re-run
// when a description is edited (otherwise a fixed body stays red until the next
// push), and it must never run on bot PRs (dependabot has no template body, so
// every dependency bump would go red). Both are one-line YAML edits that nothing
// else would catch.
const WORKFLOW = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'pr-test-plan.yml'), 'utf8');

function pullRequestTypes(): string[] {
  const match = /pull_request:\n\s+types:\s*\[([^\]]+)\]/.exec(WORKFLOW);
  if (!match) throw new Error('pr-test-plan.yml has no pull_request.types list');
  return match[1].split(',').map((type) => type.trim());
}

describe('pr-test-plan workflow', () => {
  it('re-runs when the PR description or labels change', () => {
    const types = pullRequestTypes();
    expect(types).toContain('edited');
    expect(types).toContain('labeled');
    expect(types).toContain('unlabeled');
    expect(types).toContain('synchronize');
  });

  it('exempts bot-authored PRs from the blocking body check', () => {
    const bodyCheck = WORKFLOW.slice(WORKFLOW.indexOf('- name: Check PR has a test plan'));
    expect(bodyCheck).toMatch(/if:.*!endsWith\(github\.event\.pull_request\.user\.login, '\[bot\]'\)/);
  });

  it('runs the shared gate script on a body written via env, never interpolated', () => {
    expect(WORKFLOW).toContain('PR_BODY: ${{ github.event.pull_request.body }}');
    expect(WORKFLOW).toContain('PR_LABELS: ${{ toJSON(github.event.pull_request.labels) }}');
    expect(WORKFLOW).toContain('vp run check:pr-test-plan -- --body-file pr-body.txt');
    expect(WORKFLOW).not.toMatch(/run:[^\n]*\$\{\{ github\.event\.pull_request\.body \}\}/);
  });

  it('grants only the label write permission needed by the combined policy job', () => {
    expect(WORKFLOW).toMatch(/permissions:\n\s+contents: read\n/);
    expect(WORKFLOW).toMatch(/\s+pull-requests: write\n/);
  });

  it('reconciles migration labels non-blockingly without a second workflow', () => {
    expect(WORKFLOW).toContain('- name: Label migration PRs');
    expect(WORKFLOW).toContain("const LABEL = 'db-migration';");
    expect(WORKFLOW).toMatch(/Label migration PRs[\s\S]*?continue-on-error: true[\s\S]*?actions\/github-script@v7/);
    expect(existsSync(join(__dirname, '..', '..', '.github', 'workflows', 'pr-labels.yml'))).toBe(false);
  });
});
