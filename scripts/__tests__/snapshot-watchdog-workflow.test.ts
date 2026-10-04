/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW_PATH = '.github/workflows/export-board-snapshots.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');
const ciWorkflowSource = readFileSync('.github/workflows/ci.yml', 'utf8');

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
};

type SnapshotWorkflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: string; options?: string[] }>;
    };
    schedule?: unknown;
  };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, { if?: string; env?: Record<string, string>; steps?: WorkflowStep[] }>;
};

function mappingEntry(source: string, key: string, indentation: number): string {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const startIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (startIndex < 0) throw new Error(`missing ${key} mapping at indentation ${indentation}`);

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

function stepWithId(jobSource: string, id: string): string {
  const lines = jobSource.split('\n');
  const idIndex = lines.findIndex((line) => line.trim() === `id: ${id}`);
  if (idIndex < 0) throw new Error(`missing step with id ${id}`);

  let startIndex = idIndex;
  while (startIndex > 0 && !lines[startIndex].startsWith('      - ')) startIndex -= 1;
  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !lines[endIndex].startsWith('      - ')) endIndex += 1;
  return lines.slice(startIndex, endIndex).join('\n');
}

function namedStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing workflow step: ${name}`);
  return step;
}

const workflow = parse(workflowSource) as SnapshotWorkflow;

describe('snapshot export workflow contract', () => {
  it('keeps the publisher manual-only and limited to the main branch', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {})).toEqual(['storage_target']);
    expect(workflow.on?.workflow_dispatch?.inputs?.storage_target).toEqual({
      description: 'Complete R2 migration rehearsal; the active producer must still use Tigris.',
      type: 'choice',
      options: ['r2'],
      default: 'r2',
    });
    expect(Object.keys(workflow.jobs ?? {})).toEqual(['export']);
    expect(workflow.jobs?.export?.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflowSource).not.toContain('SNAPSHOT_HOMELAB_EXPORT_ENABLED');
    expect(workflowSource).not.toContain('SNAPSHOT_PRIMARY_FENCE_ENABLED');
    expect(workflowSource).not.toContain('queue: max');
  });

  it('runs a complete, non-pruning R2 rehearsal against the current Tigris producer', () => {
    const steps = workflow.jobs?.export?.steps ?? [];
    const concurrency = workflow.concurrency;
    const validation = namedStep(steps, 'Validate isolated R2 rehearsal');
    const coverage = namedStep(steps, 'Capture trusted coverage before export');
    const identity = namedStep(steps, 'Export board snapshots (identity → board-snapshots/v1)');
    const gzip = namedStep(steps, 'Export board snapshots (gzip → board-snapshots/v1-gzip)');
    const catalog = namedStep(steps, 'Export board catalogue (gzip → board-snapshots/v1-catalog)');
    const verify = namedStep(steps, 'Verify every R2 artifact through the public domain');

    expect(concurrency).toEqual({ group: 'export-board-snapshots', 'cancel-in-progress': false });
    expect(validation.run).toContain('[ "$STORAGE_TARGET" != \'r2\' ]');
    expect(validation.run).toContain('[ "$SNAPSHOT_PUBLISHER_STORAGE_TARGET" != \'tigris\' ]');
    expect(validation.run).toContain('SNAPSHOTS_R2_AWS_ENDPOINT_URL');
    expect(coverage.run).toContain('board-snapshots/v1-gzip/manifest.json');
    expect(identity.run).toBe('vp exec tsx src/scripts/export-board-snapshots.ts --no-prune');
    expect(gzip.run).toBe(
      'vp exec tsx src/scripts/export-board-snapshots.ts --gzip --key-prefix board-snapshots/v1-gzip --no-prune',
    );
    expect(catalog.run).toBe('vp exec tsx src/scripts/export-board-catalog.ts --no-prune');
    expect(verify.run).toContain('vp run storage:verify-snapshots');
    expect(verify.run).toContain('--expected-manifest');

    // Production credentials are scoped to the steps that need them.
    expect(Object.keys(workflow.jobs?.export?.env ?? {})).not.toContain('DATABASE_URL');
  });

  it('keeps this filesystem contract in the shared guards job and aggregate status', () => {
    const snapshotFilter = mappingEntry(ciWorkflowSource, 'snapshotWatchdogWorkflow', 6);
    const snapshotPaths = mappingEntry(ciWorkflowSource, 'snapshotWatchdogWorkflow', 12);
    const guardsJob = mappingEntry(ciWorkflowSource, 'guards', 2);
    const snapshotGuard = stepWithId(guardsJob, 'snapshot-watchdog');
    const ciStatus = mappingEntry(ciWorkflowSource, 'ci-status', 2);

    expect(snapshotFilter).toContain("github.event_name != 'pull_request' && 'true'");
    expect(snapshotPaths).toContain("- '.github/workflows/export-board-snapshots.yml'");
    expect(snapshotPaths).toContain("- 'scripts/__tests__/snapshot-watchdog-workflow.test.ts'");
    expect(snapshotGuard).toContain('snapshot-watchdog-workflow.test.ts --reporter=agent');
    expect(snapshotGuard).toContain("needs.changes.outputs.snapshotWatchdogWorkflow == 'true'");
    expect(ciStatus).toContain('- guards');
    expect(ciWorkflowSource).not.toMatch(/^  snapshot-watchdog-guards:/m);
  });
});
