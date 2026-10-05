import { describe, expect, it } from 'vitest';
import {
  OFFLINE_MIGRATIONS_PATH,
  OFFLINE_MIGRATION_ACK_LINE,
  findOfflineMigrationProblem,
  hasOfflineMigrationAck,
  isOfflineMigrationsPath,
} from '../offline-migration';

describe('isOfflineMigrationsPath', () => {
  it('matches the migration list, with or without a leading ./', () => {
    expect(isOfflineMigrationsPath(OFFLINE_MIGRATIONS_PATH)).toBe(true);
    expect(isOfflineMigrationsPath(`./${OFFLINE_MIGRATIONS_PATH}`)).toBe(true);
    expect(isOfflineMigrationsPath(`${OFFLINE_MIGRATIONS_PATH}\n`)).toBe(true);
  });

  it('does not match its tests, its neighbours or the server-side migrations', () => {
    expect(isOfflineMigrationsPath('packages/shared/offline-sync/src/db/__tests__/migrations.test.ts')).toBe(false);
    expect(isOfflineMigrationsPath('packages/shared/offline-sync/src/db/schema.ts')).toBe(false);
    expect(isOfflineMigrationsPath('packages/db/drizzle/0123_add_column.sql')).toBe(false);
    expect(isOfflineMigrationsPath('packages/db/scripts/migrate.ts')).toBe(false);
  });
});

describe('hasOfflineMigrationAck', () => {
  it('accepts the canonical line', () => {
    expect(hasOfflineMigrationAck(OFFLINE_MIGRATION_ACK_LINE)).toBe(true);
  });

  it('accepts the sentence reworded for the PR, as long as it is ticked and says both things', () => {
    expect(hasOfflineMigrationAck('* [X] The previous stable bundle can still read v11: one new nullable column')).toBe(
      true,
    );
    expect(hasOfflineMigrationAck('## Risk\n\n- [x] Previous  stable can read this (index only)\n')).toBe(true);
  });

  it('rejects an unticked box', () => {
    expect(hasOfflineMigrationAck(OFFLINE_MIGRATION_ACK_LINE.replace('[x]', '[ ]'))).toBe(false);
  });

  it('rejects the sentence without a checkbox', () => {
    expect(hasOfflineMigrationAck('The previous stable bundle can read this schema.')).toBe(false);
  });

  it('rejects a ticked box that says something else', () => {
    expect(hasOfflineMigrationAck('- [x] No release note needed (internal / technical change)')).toBe(false);
    expect(hasOfflineMigrationAck('- [x] The previous stable bundle is fine')).toBe(false);
    expect(hasOfflineMigrationAck('- [x] Old clients can read this schema')).toBe(false);
  });

  it('rejects the line inside a code fence or an HTML comment', () => {
    expect(hasOfflineMigrationAck(['```', OFFLINE_MIGRATION_ACK_LINE, '```'].join('\n'))).toBe(false);
    expect(hasOfflineMigrationAck(`<!--\n${OFFLINE_MIGRATION_ACK_LINE}\n-->`)).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(hasOfflineMigrationAck('')).toBe(false);
    expect(hasOfflineMigrationAck(null)).toBe(false);
    expect(hasOfflineMigrationAck(undefined)).toBe(false);
  });
});

describe('findOfflineMigrationProblem', () => {
  it('is silent when the migration list is untouched, whatever the body says', () => {
    expect(findOfflineMigrationProblem('', [])).toBeNull();
    expect(
      findOfflineMigrationProblem(null, ['packages/mobile/app/_layout.tsx', 'docs/offline-sync-plan.md']),
    ).toBeNull();
  });

  it('names the file and the line to add when the statement is missing', () => {
    const problem = findOfflineMigrationProblem('## Summary\nAdds v11.', ['README.md', OFFLINE_MIGRATIONS_PATH]);
    expect(problem).toContain(OFFLINE_MIGRATIONS_PATH);
    expect(problem).toContain(OFFLINE_MIGRATION_ACK_LINE);
  });

  it('passes a PR that changes the migration list and carries the statement', () => {
    expect(
      findOfflineMigrationProblem(`## Summary\nAdds v11.\n\n${OFFLINE_MIGRATION_ACK_LINE}`, [OFFLINE_MIGRATIONS_PATH]),
    ).toBeNull();
  });
});
