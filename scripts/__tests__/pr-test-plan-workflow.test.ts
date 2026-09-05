import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

/**
 * The `backend` label tells a tester that an OTA preview alone will not
 * exercise the PR. Asserting the step's text exists would prove nothing, so
 * this lifts the step's own declarations and its own `wanted` expression out of
 * the YAML and runs them. Widen the backend prefixes, drop a mobile path, or
 * turn the `&&` into an `||` and these go red.
 */
function backendLabelDecision(): (paths: string[]) => boolean {
  const workflow = parse(WORKFLOW) as {
    jobs: { check: { steps: { name?: string; with?: { script?: string } }[] } };
  };
  const step = workflow.jobs.check.steps.find((entry) => entry.name === 'Label PRs that also need a backend deploy');
  if (!step?.with?.script) throw new Error('pr-test-plan.yml has no backend-label step');
  const script = step.with.script;

  // The pure half of the step: the two path lists, verbatim.
  const declarations = /(const BACKEND_PREFIXES[\s\S]*?mobile-ota-preview\.yml';)/.exec(script);
  if (!declarations) throw new Error('backend-label step has no path declarations');

  // The decision itself, verbatim — so the test cannot drift from the composition.
  const expression = /wanted =\s*([\s\S]*?);\n/.exec(script);
  if (!expression) throw new Error('backend-label step has no `wanted` expression');

  // Running the workflow's own source is the whole point: a test that re-typed
  // the predicate would go green against a mutated workflow.
  // oxlint-disable-next-line no-implied-eval
  return new Function('paths', `${declarations[1]}\nreturn (${expression[1]});`) as (paths: string[]) => boolean;
}

describe('pr-test-plan backend label', () => {
  const wanted = backendLabelDecision();

  it('labels a PR that changes both the app and the server', () => {
    expect(wanted(['packages/mobile/src/app.tsx', 'packages/backend/src/graphql/resolvers/qa/queries.ts'])).toBe(true);
  });

  it('counts a migration as a server change', () => {
    expect(wanted(['packages/mobile/src/app.tsx', 'packages/db/drizzle/0200_add_column.sql'])).toBe(true);
  });

  it('labels a shared-schema change, which is both halves at once', () => {
    // The SDL ships in the bundle AND has to be deployed for the resolver to
    // answer the new field, so a schema-only PR genuinely needs both.
    expect(wanted(['packages/shared-schema/src/schema/qa.ts'])).toBe(true);
  });

  it('leaves a server-only PR alone — it has no preview to caveat', () => {
    expect(wanted(['packages/backend/src/services/github-qa.ts', 'packages/db/src/schema/app/qa-verdicts.ts'])).toBe(
      false,
    );
  });

  it('leaves an app-only PR alone — it needs no deploy', () => {
    expect(wanted(['packages/mobile/src/components/qa/QaPickScreen.tsx', 'patches/expo.patch'])).toBe(false);
  });

  it('leaves a PR that touches neither alone', () => {
    expect(wanted(['docs/crowdsourced-qa.md', '.github/workflows/ci.yml'])).toBe(false);
  });

  it('does not treat every package as a server change', () => {
    expect(wanted(['packages/mobile/src/app.tsx', 'packages/web/app/page.tsx'])).toBe(false);
    expect(wanted(['packages/mobile/src/app.tsx', 'packages/board-constants/src/index.ts'])).toBe(false);
  });

  it('writes the label non-blockingly, like its neighbour', () => {
    expect(WORKFLOW).toMatch(
      /Label PRs that also need a backend deploy[\s\S]*?continue-on-error: true[\s\S]*?actions\/github-script@v7/,
    );
  });
});

/**
 * The `affectsMobilePreview` closure the backend-label step uses is a third
 * verbatim copy of the one in mobile-ota-preview.yml (the second lives in
 * mobile-ota-preview-prompt.yml). Extracting it into a shared file is the real
 * fix and is not this change; until then, this asserts the copies agree.
 *
 * The failure it exists for is silent: someone narrows the OTA trigger list,
 * pr-test-plan.yml keeps the old one, and PRs quietly get labelled `backend`
 * for a preview that no longer publishes.
 */
function mobilePreviewPaths(workflow: string): string[] {
  const closure = /const affectsMobilePreview = \(path\) =>([\s\S]*?);\n/.exec(workflow);
  if (!closure) throw new Error('workflow has no affectsMobilePreview closure');
  return [...closure[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

describe('affectsMobilePreview stays in step across workflows', () => {
  const OTA_PREVIEW = readFileSync(
    join(__dirname, '..', '..', '.github', 'workflows', 'mobile-ota-preview.yml'),
    'utf8',
  );

  it('the backend-label step matches the OTA preview gate', () => {
    expect(mobilePreviewPaths(WORKFLOW)).toEqual(mobilePreviewPaths(OTA_PREVIEW));
  });

  it('matches the fork prompt too', () => {
    const prompt = readFileSync(
      join(__dirname, '..', '..', '.github', 'workflows', 'mobile-ota-preview-prompt.yml'),
      'utf8',
    );
    expect(mobilePreviewPaths(prompt)).toEqual(mobilePreviewPaths(OTA_PREVIEW));
  });
});
