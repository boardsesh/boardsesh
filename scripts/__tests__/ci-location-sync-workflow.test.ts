/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Return one YAML mapping entry by exact key and indentation. This deliberately
 * understands mapping boundaries instead of matching the whole workflow with a
 * broad regex. The repo has no directly declared YAML parser; keeping this
 * reader tiny avoids adding dependency/lockfile churn for a CI contract test.
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

function mappingLine(source: string, key: string, indentation: number): string {
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const line = source.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`missing ${key} line at indentation ${indentation}`);
  return line.trim();
}

describe('location-sync CI integration contract', () => {
  const changesJob = mappingEntry(workflowSource, 'changes', 2);
  const integrationJob = mappingEntry(workflowSource, 'test-location-sync-integration', 2);
  const testReportJob = mappingEntry(workflowSource, 'test-report', 2);
  const ciStatusJob = mappingEntry(workflowSource, 'ci-status', 2);

  it('selects location-sync and database changes and includes them in runAny', () => {
    expect(changesJob).toContain(
      "locationSync: ${{ github.event_name != 'pull_request' && 'true' || steps.filter.outputs.locationSync }}",
    );
    expect(changesJob).toContain("steps.filter.outputs.locationSync == 'true'");

    const locationSyncFilter = mappingEntry(changesJob, 'locationSync', 12);
    expect(locationSyncFilter).toContain("- 'packages/location-sync/**'");
    expect(locationSyncFilter).toContain("- 'packages/db/**'");
    expect(locationSyncFilter).toContain("- '.github/workflows/ci.yml'");
  });

  it('runs for direct changes, dependency changes, and shared CI changes', () => {
    expect(mappingLine(integrationJob, 'if', 4)).toBe(
      "if: needs.changes.outputs.locationSync == 'true' || needs.changes.outputs.sharedDeps == 'true' || needs.changes.outputs.sharedSchema == 'true' || needs.changes.outputs.rootCi == 'true'",
    );

    const runAny = mappingLine(changesJob, 'runAny', 6);
    expect(runAny).toContain("steps.filter.outputs.locationSync == 'true'");
    expect(runAny).toContain("steps.filter.outputs.sharedDeps == 'true'");
    expect(runAny).toContain("steps.filter.outputs.sharedSchema == 'true'");
    expect(runAny).toContain("steps.filter.outputs.rootCi == 'true'");
    expect(runAny).toContain("steps.filter.outputs.staticAssets == 'true'");
  });

  it('runs the full project against the pinned migrated dev database', () => {
    expect(integrationJob).toContain(
      'image: ghcr.io/boardsesh/boardsesh-dev-db@sha256:d4574a27a639919b70d89c457e88f17bf672b358dd38dbdc3c2ba5f65ecc44e5',
    );
    expect(integrationJob).toContain("VERIFY_MIGRATION_JOURNAL: '1'");
    expect(integrationJob).toContain('run: vp exec pnpm --filter @boardsesh/db run db:migrate');
    expect(integrationJob).toContain("REQUIRE_LOCATION_SYNC_INTEGRATION: '1'");
    expect(integrationJob).toContain('vp test run --project location-sync');
    expect(integrationJob).not.toContain('--changed');
  });

  it('publishes JUnit and makes both report and aggregate status depend on the job', () => {
    expect(integrationJob).toContain('--reporter=junit');
    expect(integrationJob).toContain('name: test-results-location-sync');
    expect(integrationJob).toContain('path: packages/location-sync/test-results/junit-location-sync.xml');
    expect(testReportJob).toContain('test-location-sync-integration');
    expect(ciStatusJob).toContain('- test-location-sync-integration');
  });
});
