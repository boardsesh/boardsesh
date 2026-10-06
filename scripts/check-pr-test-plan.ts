/// <reference types="node" />

/**
 * The PR test-plan gate. Fails (exit 1) when a PR body has no usable
 * `## Test plan` (1–5 numbered steps) or no `Risk: N/5 — why` line, unless the
 * `skip-qa-gate` label is present. Testers read the plan verbatim in the mobile
 * app, so the rules are the reader's, not the author's: short, numbered, one
 * action and one expected result per step. The rule set itself lives in
 * @boardsesh/pr-body (validatePrBody) so the backend parses bodies the same way.
 *
 * It also holds a PR that changes the phone's SQLite migration list
 * (packages/shared/offline-sync/src/db/migrations.ts) until the body carries a
 * ticked statement that the previous stable bundle can read the result. Older JS
 * can land on a migrated phone (a reverted canary update, a climber leaving early
 * updates); see docs/offline-sync-plan.md, "Older JS on a newer database". That
 * rule needs the PR's changed files, and `skip-qa-gate` does not waive it.
 *
 * Inputs (designed so CI never has to shell-escape a multi-line markdown body):
 *   --body-file <path>   Read the PR body from a file (CI writes
 *                        github.event.pull_request.body to it). Falls back to
 *                        stdin when the flag is absent.
 *   --changed-files-file <path>
 *                        The PR's changed paths, one per line (CI writes the
 *                        pulls/files listing to it). Absent = no paths known, so
 *                        the migration rule is not applied; CI always passes it.
 *   PR_LABELS env        JSON array of label objects ([{ "name": "..." }, ...],
 *                        the shape of github.event.pull_request.labels) OR a
 *                        plain comma-separated list. Empty/unset = no labels.
 *
 * Usage:
 *   vp run check:pr-test-plan -- --body-file pr-body.txt --changed-files-file pr-files.txt
 *   (PR_LABELS in env)
 */

import { readFileSync } from 'node:fs';
import { validatePrBody } from '@boardsesh/pr-body';
import { parseChangedPaths } from './lib/pr-changed-paths';
import { parseLabels } from './lib/pr-labels';

function readBody(): string {
  const args = process.argv.slice(2);
  const bodyFileFlag = args.indexOf('--body-file');
  if (bodyFileFlag !== -1) {
    const path = args[bodyFileFlag + 1];
    if (!path) {
      console.error('[pr-test-plan] --body-file given without a path.');
      process.exit(1);
    }
    return readFileSync(path, 'utf8');
  }
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readChangedPaths(): string[] {
  const args = process.argv.slice(2);
  const changedFilesFlag = args.indexOf('--changed-files-file');
  if (changedFilesFlag === -1) return [];
  const path = args[changedFilesFlag + 1];
  if (!path) {
    console.error('[pr-test-plan] --changed-files-file given without a path.');
    process.exit(1);
  }
  // No catch: a listing CI could not write must fail the gate, not skip the rule.
  return parseChangedPaths(readFileSync(path, 'utf8'));
}

// GitHub Actions annotation lines; harmless noise when run locally.
function annotate(kind: 'error' | 'warning', message: string): void {
  const stream = kind === 'error' ? console.error : console.warn;
  stream(`::${kind}::${message}`);
}

function main(): void {
  const labels = parseLabels(process.env.PR_LABELS);
  const result = validatePrBody(readBody(), labels, readChangedPaths());

  for (const warning of result.warnings) annotate('warning', warning);
  for (const error of result.errors) annotate('error', error);

  if (result.ok) {
    const steps = result.testPlan?.steps.length ?? 0;
    const risk = result.risk ? `risk ${result.risk.level}/5` : 'risk not checked';
    console.log(`[pr-test-plan] OK — ${steps} step${steps === 1 ? '' : 's'}, ${risk}.`);
    return;
  }

  console.error(
    [
      '',
      '✖ This PR description does not pass the test-plan gate.',
      '',
      ...result.errors.map((error) => `  - ${error}`),
      '',
      'A tester reads "## Test plan" on their phone: 1–5 numbered steps, one action',
      'then what they should see, ≤ 12 words each. "## Risk" carries `Risk: N/5 — why`',
      '(1 = docs/CI/deps … 5 = BLE/OTA/migrations). See the PR template. Editing the',
      'description re-runs this check. A maintainer can apply the "skip-qa-gate" label',
      '(it covers the test plan and the risk score, not the offline migration statement).',
    ].join('\n'),
  );
  process.exit(1);
}

main();
