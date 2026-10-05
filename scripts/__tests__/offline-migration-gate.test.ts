import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OFFLINE_MIGRATIONS_PATH, OFFLINE_MIGRATION_ACK_LINE, hasOfflineMigrationAck } from '@boardsesh/pr-body';

// The offline migration gate (`@boardsesh/pr-body`, offline-migration.ts) is pure
// and tested next to its code. These are the two things about it that live in
// the repo rather than in the function: the path it watches, and the copy of the
// line authors paste. Both go stale silently otherwise.
const REPO_ROOT = join(__dirname, '..', '..');

describe('offline migration gate wiring', () => {
  it('watches a file that exists, so a rename cannot silently retire the gate', () => {
    expect(existsSync(join(REPO_ROOT, OFFLINE_MIGRATIONS_PATH))).toBe(true);
  });

  it('watches the file that defines the migration list', () => {
    const source = readFileSync(join(REPO_ROOT, OFFLINE_MIGRATIONS_PATH), 'utf8');
    expect(source).toContain('export const MIGRATIONS');
    expect(source).toContain('export async function runMigrations');
  });

  describe('the PR template', () => {
    const template = readFileSync(join(REPO_ROOT, '.github', 'pull_request_template.md'), 'utf8');

    it('carries the canonical line for authors to copy', () => {
      expect(template).toContain(OFFLINE_MIGRATION_ACK_LINE);
    });

    it('names the file the rule is about', () => {
      expect(template).toContain(OFFLINE_MIGRATIONS_PATH);
    });

    it('keeps the line inside a comment, so a PR that never touches migrations carries nothing', () => {
      expect(hasOfflineMigrationAck(template)).toBe(false);
    });
  });
});
