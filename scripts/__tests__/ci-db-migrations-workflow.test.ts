/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

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

function stepWithName(jobSource: string, name: string): string {
  const lines = jobSource.split('\n');
  const startIndex = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (startIndex < 0) throw new Error(`missing workflow step: ${name}`);
  const stepIndentation = lines[startIndex].length - lines[startIndex].trimStart().length;

  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    const lineIndentation = line.length - line.trimStart().length;
    if (lineIndentation === stepIndentation && line.trimStart().startsWith('- ')) {
      endIndex = lineIndex;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('db-migrations PostgreSQL service wiring', () => {
  const dbMigrationsJob = mappingEntry(workflowSource, 'db-migrations', 2);
  const services = withoutComments(mappingEntry(dbMigrationsJob, 'services', 4));
  const postgres17 = withoutComments(mappingEntry(services, 'postgres', 6));
  const postgres18 = withoutComments(mappingEntry(services, 'postgres18', 6));

  it('keeps existing PostgreSQL 17 checks isolated from the PostgreSQL 18 smoke', () => {
    expect(postgres17).toContain('image: postgres:17');
    expect(postgres17).toContain('- 5432:5432');
    expect(postgres18).toContain('image: postgres:18');
    expect(postgres18).toContain('- 5433:5432');
    expect(postgres18).toContain('--health-cmd "pg_isready -U postgres"');
    expect(postgres18).toContain('--health-interval 2s');
    expect(postgres18).toContain('--health-timeout 5s');
    expect(postgres18).toContain('--health-retries 25');

    const smokeStep = stepWithName(
      dbMigrationsJob,
      'Run the board snapshot replica-fence migration through the superuser and restricted PG18 apply paths',
    );
    expect(smokeStep).toContain('SNAPSHOT_MIGRATION_PG18_DB_URL: postgres://postgres:postgres@localhost:5433/postgres');
    expect(smokeStep).toContain("SNAPSHOT_MIGRATION_PG18_ALLOW_LOCAL_ADMIN: '1'");
    expect(smokeStep).toContain('run: bash scripts/board-snapshot-migration-pg18.test.sh');
    expect(smokeStep).not.toContain('localhost:5432');

    expect(stepWithName(dbMigrationsJob, 'Verify the migration journal check against a real database')).toContain(
      'MIGRATION_JOURNAL_DB_URL: postgres://postgres:postgres@localhost:5432/postgres',
    );
    expect(stepWithName(dbMigrationsJob, 'Replay MoonBoard reconciliation and verify report projections')).toContain(
      'MIGRATION_REPLAY_DB_URL: postgres://postgres:postgres@localhost:5432/postgres',
    );
    expect(stepWithName(dbMigrationsJob, 'Serial-plan default is applied, or the failure is surfaced')).toContain(
      'SERIAL_PLAN_DB_URL: postgres://postgres:postgres@localhost:5432/postgres',
    );
  });

  it('runs this contract from the migration job that owns both services', () => {
    const contractStep = stepWithName(dbMigrationsJob, 'Check database service wiring');
    expect(contractStep).toContain(
      'vp test run --project scripts scripts/__tests__/ci-db-migrations-workflow.test.ts --reporter=agent',
    );
    expect(mappingEntry(workflowSource, 'dbMigrations', 12)).toContain(
      "- 'scripts/__tests__/ci-db-migrations-workflow.test.ts'",
    );
  });
});
