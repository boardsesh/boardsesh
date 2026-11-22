import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isNativeAppAffecting } from '../lib/app-build-inputs.mjs';

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

  it('hands the gate the changed files, from a step that cannot be skipped', () => {
    const listing = WORKFLOW.slice(
      WORKFLOW.indexOf('- name: List the files this PR changes'),
      WORKFLOW.indexOf('- name: Check PR has a test plan'),
    );
    expect(listing).toContain('github.rest.pulls.listFiles');
    expect(listing).toContain("fs.writeFileSync('pr-files.txt'");
    // A rename away from the migration list still has to trip the rule.
    expect(listing).toContain('previous_filename');
    // The offline migration rule depends on this list, so a failed listing must
    // fail the job instead of letting the check run without it.
    expect(listing).not.toContain('continue-on-error');
    expect(listing).toMatch(/if:.*!endsWith\(github\.event\.pull_request\.user\.login, '\[bot\]'\)/);
    expect(WORKFLOW).toContain('--changed-files-file pr-files.txt');
    // After the checkout, which would otherwise clean the file away.
    expect(WORKFLOW.indexOf('- name: List the files this PR changes')).toBeGreaterThan(
      WORKFLOW.indexOf('- uses: actions/checkout@v6'),
    );
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

  const prefixes = /const BACKEND_PREFIXES = \[[^\]]*\];/.exec(script);
  if (!prefixes) throw new Error('backend-label step has no BACKEND_PREFIXES list');
  expect(script).toContain('isNativeAppAffecting: affectsMobilePreview');
  expect(script).toContain('scripts/lib/app-build-inputs.mjs');

  // The decision itself, verbatim — so the test cannot drift from the composition.
  const expression = /wanted =\s*([\s\S]*?);\n/.exec(script);
  if (!expression) throw new Error('backend-label step has no `wanted` expression');

  // Running the workflow's own source is the whole point: a test that re-typed
  // the predicate would go green against a mutated workflow.
  //
  // Yes, this executes a file any PR can edit. So can every other file in this
  // directory — a PR that wanted to run code in CI would just edit the test
  // body. The eval adds no reach the test file did not already have, and it is
  // what makes the guard impossible to satisfy by copying the logic.
  // oxlint-disable-next-line no-implied-eval
  const evaluate = new Function('paths', 'affectsMobilePreview', `${prefixes[0]}\nreturn (${expression[1]});`) as (
    paths: string[],
    affectsMobilePreview: typeof isNativeAppAffecting,
  ) => boolean;
  return (paths) => evaluate(paths, isNativeAppAffecting);
}

describe('pr-test-plan backend label', () => {
  // Built in beforeAll, not at describe scope: a throw out here aborts
  // collection for the whole file, which reads as "the suite is broken" rather
  // than "the extractor no longer matches the workflow".
  let wanted: (paths: string[]) => boolean;
  beforeAll(() => {
    wanted = backendLabelDecision();
  });

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
    expect(wanted(['docs/qa/crowdsourced-qa.md', '.github/workflows/ci.yml'])).toBe(false);
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

describe('policy checkout isolation', () => {
  it('keeps sparse policy files outside the later dependency-install checkout', () => {
    const workflow = parse(WORKFLOW) as {
      jobs: {
        check: {
          steps: Array<{
            name?: string;
            uses?: string;
            with?: { path?: string; script?: string };
          }>;
        };
      };
    };
    const steps = workflow.jobs.check.steps;
    const policyIndex = steps.findIndex((step) => step.name === 'Check out app input policy');
    expect(policyIndex).toBeGreaterThanOrEqual(0);
    expect(steps[policyIndex].with?.path).toBe('app-input-policy');
    const fullCheckout = steps.slice(policyIndex + 1).find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(fullCheckout).toBeDefined();
    expect(fullCheckout?.with?.path).toBeUndefined();
    const label = steps.find((step) => step.name === 'Label PRs that also need a backend deploy');
    expect(label?.with?.script).toContain('/app-input-policy/scripts/lib/app-build-inputs.mjs');
  });
});

describe('shared app input policy across workflows', () => {
  it.each(['mobile-ota-preview.yml', 'mobile-ota-preview-prompt.yml', 'pr-test-plan.yml'])(
    '%s imports the common policy before deciding eligibility',
    (filename) => {
      const source = readFileSync(join(__dirname, '../../.github/workflows', filename), 'utf8');
      expect(source).toContain('scripts/lib/app-build-inputs.mjs');
      expect(source).toContain('await import(');
      expect(source).not.toContain("path.startsWith('packages/shared/')");
    },
  );
});
