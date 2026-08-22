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

/** Strip `#` comment lines so a job's rationale can never satisfy an assertion. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * The two REST-surface oracles reconcile the spec/verdict tables against the
 * filesystem at run time — readdirSync over packages/web/app/api/**, readFileSync
 * of vercel.json, existsSync per registered OpenAPI path. None of that is a
 * static import, so Vitest's `--changed` module-graph analysis in test-default
 * never selects them for a route-file-only diff, which is the one diff shape
 * they exist to catch. Measured on #4663: adding a route file and, separately,
 * deleting one each selected ZERO specs. The dedicated `rest-surface` job is the
 * fix; this contract stops a future narrowing from quietly undoing it.
 */
describe('rest-surface CI job contract', () => {
  const changesJob = mappingEntry(workflowSource, 'changes', 2);
  const restSurfaceJob = mappingEntry(workflowSource, 'rest-surface', 2);
  const restSurfaceSteps = withoutComments(restSurfaceJob);
  const ciStatusJob = withoutComments(mappingEntry(workflowSource, 'ci-status', 2));

  it('gates on the API tree and everything the two oracles read', () => {
    expect(changesJob).toContain(
      "restSurface: ${{ github.event_name != 'pull_request' && 'true' || steps.filter.outputs.restSurface }}",
    );

    const filter = withoutComments(mappingEntry(changesJob, 'restSurface', 12));
    // packages/web/app/api/** is the load-bearing glob: a route-file-only diff
    // matches anyJs (so test-default runs) but selects neither oracle there.
    expect(filter).toContain("- 'packages/web/app/api/**'");
    expect(filter).toContain("- 'packages/web/vercel.json'");
    expect(filter).toContain("- 'packages/web/app/lib/api-docs/**'");
    expect(filter).toContain("- 'packages/web/app/__tests__/rest-surface-inventory.test.ts'");
  });

  it('runs whenever the API tree or the shared CI config changes', () => {
    expect(restSurfaceSteps).toContain(
      "if: needs.changes.outputs.restSurface == 'true' || needs.changes.outputs.rootCi == 'true'",
    );
  });

  it('runs both oracles unfiltered', () => {
    expect(restSurfaceSteps).toContain('packages/web/app/__tests__/rest-surface-inventory.test.ts');
    expect(restSurfaceSteps).toContain('packages/web/app/lib/api-docs/__tests__/openapi-document.test.ts');
    // The whole point of the job. `--changed` here would restore the blind spot.
    expect(restSurfaceSteps).not.toContain('--changed');
  });

  it('runs this contract spec from inside the job it guards', () => {
    // Without this step nothing un-filtered reads ci.yml, so the gate above
    // could be narrowed by a ci.yml-only diff with nothing going red on the PR
    // — the same blind spot, one level up.
    expect(restSurfaceSteps).toContain('scripts/__tests__/ci-rest-surface-workflow.test.ts');
  });

  it('makes the aggregate status depend on the job', () => {
    expect(ciStatusJob).toContain('- rest-surface');
  });
});
