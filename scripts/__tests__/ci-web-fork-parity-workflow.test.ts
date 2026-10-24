/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Return one YAML mapping entry by exact key and indentation. Copied from
 * ci-lint-scope.test.ts / ci-location-sync-workflow.test.ts on purpose: the
 * repo declares no YAML parser, and a CI contract test is not worth the
 * dependency churn.
 */
function mappingEntry(source: string, key: string, indentation: number): string {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const startIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (startIndex < 0) {
    throw new Error(`missing ${key} mapping at indentation ${indentation}`);
  }

  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndentation = line.length - line.trimStart().length;
    if (lineIndentation <= indentation) {
      endIndex = lineIndex;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * One step of a job, found by its `id:`, from its `- ` line to the next step at
 * the same indentation.
 */
function stepWithId(jobSource: string, id: string): string {
  const lines = jobSource.split('\n');
  const idIndex = lines.findIndex((line) => line.trim() === `id: ${id}`);
  if (idIndex < 0) {
    throw new Error(`missing step with id ${id}`);
  }
  let startIndex = idIndex;
  while (startIndex > 0 && !lines[startIndex].startsWith('      - ')) startIndex -= 1;
  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !lines[endIndex].startsWith('      - ')) endIndex += 1;
  return lines.slice(startIndex, endIndex).join('\n');
}

/** Strip `#` comment lines so a job's rationale can never satisfy an assertion. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * web-fork-export-parity.test.ts reads every X.ts / X.web.ts(x) pair and every
 * importer with readFileSync and imports nothing from the app, so Vitest's
 * `--changed` module-graph analysis in test-default never selects it for a
 * source diff. #6067 added getQueueSnapshotGeneration to queue-snapshot-store.ts
 * without its .web fork: the spec went red only on main, and app.boardsesh.com
 * failed to boot for 1 h 40 min (#6110). The dedicated `web-fork-parity` step of
 * the `guards` job is the fix; this contract stops a future narrowing from
 * quietly undoing it.
 */
describe('web-fork-parity CI guard contract', () => {
  const changesJob = mappingEntry(workflowSource, 'changes', 2);
  const guardsJob = withoutComments(mappingEntry(workflowSource, 'guards', 2));
  const parityStep = stepWithId(guardsJob, 'web-fork-parity');
  const ciStatusJob = withoutComments(mappingEntry(workflowSource, 'ci-status', 2));

  it('exports the mobile gate with a push fallback', () => {
    expect(changesJob).toContain(
      "mobile: ${{ github.event_name != 'pull_request' && 'true' || steps.filter.outputs.mobile }}",
    );
  });

  it('runs whenever mobile or the shared CI config changes, even after an earlier guard fails', () => {
    expect(parityStep).toContain('!cancelled()');
    expect(parityStep).toContain("(needs.changes.outputs.mobile == 'true' || needs.changes.outputs.rootCi == 'true')");
    expect(parityStep).not.toContain('continue-on-error');
  });

  it('runs the parity spec unfiltered', () => {
    expect(parityStep).toContain('packages/mobile/src/__tests__/web-fork-export-parity.test.ts');
    // The whole point of the step. `--changed` here would restore the blind spot.
    expect(parityStep).not.toContain('--changed');
  });

  it('runs this contract spec from inside the step it guards', () => {
    // Nothing else reads ci.yml un-filtered, so without this the gate above
    // could be narrowed by a ci.yml-only diff with nothing going red on the PR.
    expect(parityStep).toContain('scripts/__tests__/ci-web-fork-parity-workflow.test.ts');
  });

  it('makes the aggregate status depend on the job that runs it', () => {
    expect(ciStatusJob).toContain('- guards');
  });
});
