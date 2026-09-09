/// <reference types="node" />

/**
 * #5352 round 5b. Migration 0225 could not apply
 * `max_parallel_workers_per_gather = 0` in production — `ALTER DATABASE ... SET`
 * needs database ownership and the migration role is deliberately not the owner
 * — and its `EXCEPTION ... RAISE WARNING` reported that as success.
 *
 * The replacement is a deploy job. A deploy job that exists but is wired to the
 * wrong credential, or whose failure nobody is told about, is the same silent
 * no-op in a new costume, so the wiring is pinned here.
 *
 * Reads the workflow with readFileSync, so Vitest's `--changed` module graph
 * can never relate it to a workflow-only diff. CI runs it unfiltered in the
 * deploy-config job, alongside the other production-deploy contract suites.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/production-deploy.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

/** Return one YAML mapping entry by exact key and indentation. */
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

const verifyJob = withoutComments(mappingEntry(workflowSource, 'verify-serial-plan', 2));
const migrateJob = withoutComments(mappingEntry(workflowSource, 'migrate', 2));
const notifyFailureJob = withoutComments(mappingEntry(workflowSource, 'notify-failure', 2));

describe('production-deploy verify-serial-plan (#5352)', () => {
  it('runs the verification after migrations, in the Production environment', () => {
    expect(verifyJob).toContain('needs: [migrate]');
    expect(verifyJob).toContain('environment: Production');
    expect(verifyJob).toContain('vp exec pnpm --filter @boardsesh/db run db:verify-serial-plan');
  });

  it('checks through the RUNTIME credential, not the migration one', () => {
    // The fact worth asserting is what the APPLICATION's own sessions resolve
    // the setting to — the same value GET /health/db reports. Checking through
    // MIGRATOR_DATABASE_URL (or an admin URL) would assert a session nobody
    // serves traffic from.
    expect(verifyJob).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(verifyJob).not.toContain('MIGRATOR_DATABASE_URL');
  });

  it('offers the optional owner credential that lets it self-heal', () => {
    expect(verifyJob).toContain('ADMIN_DATABASE_URL: ${{ secrets.ADMIN_DATABASE_URL }}');
  });

  it('never becomes a silent step', () => {
    // `continue-on-error` would rebuild 0225's RAISE WARNING at the workflow
    // level: a red condition that reports green.
    expect(verifyJob).not.toContain('continue-on-error');
  });

  it('alerts Discord when it fails', () => {
    // Loudness is the whole point of the job. Without this the failure is one
    // more line nobody reads.
    expect(notifyFailureJob).toContain('verify-serial-plan,');
    expect(notifyFailureJob).toContain('VERIFY_SERIAL_PLAN: ${{ needs.verify-serial-plan.result }}');
    expect(notifyFailureJob).toContain('verify-serial-plan: %s');
  });

  it('does not gate the release train on a pre-existing database condition', () => {
    // Deliberate: the setting is a property of the database, not of the commit,
    // and a deploy cannot fix it. Blocking every future release on an ops
    // action would trade a reported miss for a self-inflicted outage. If that
    // trade is ever revisited, this assertion is the place it gets revisited.
    for (const deployJob of ['deploy-production-backend', 'deploy-web-railway', 'deploy-cloudflare']) {
      const jobSource = withoutComments(mappingEntry(workflowSource, deployJob, 2));
      expect(jobSource, deployJob).not.toContain('verify-serial-plan');
    }
    expect(migrateJob).toContain('needs: [detect-changes, build-web, build-backend, sync-static-assets]');
  });
});
