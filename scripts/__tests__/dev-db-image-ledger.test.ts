/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * File-text guard for #4211.
 *
 * `Dockerfile.dev-db` applies the migration journal in a psql loop and writes
 * drizzle's ledger by hand. It used to stamp `created_at` with the image's build
 * clock, which becomes a high-water mark drizzle's applier can never clear — so
 * every migration written after the image was built is silently skipped on that
 * database, forever.
 *
 * Building the image to check this takes tens of minutes and hits the network
 * hard (six APK downloads, pgloader, the MoonBoard import), so the practical
 * coverage is this text guard plus the in-build assertion it requires: the
 * ledger's high-water mark must equal the journal's newest `when`.
 */
const DOCKERFILE_PATH = 'packages/db/docker/Dockerfile.dev-db';
const dockerfileSource = readFileSync(DOCKERFILE_PATH, 'utf8');

/** Non-comment lines only — the `date +%s` ban must not be satisfiable by a comment. */
const executableLines = dockerfileSource
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('dev-db image migration ledger', () => {
  it('never stamps ledger rows with the build clock', () => {
    const ledgerInserts = executableLines
      .split('\n')
      .filter((line) => line.includes('INSERT INTO') && line.includes('__drizzle_migrations'));
    expect(ledgerInserts.length).toBeGreaterThan(0);
    for (const insert of ledgerInserts) {
      expect(insert).not.toContain('date +%s');
      expect(insert).toContain('$when');
    }
  });

  it('reads the when of each entry out of the journal', () => {
    expect(executableLines).toContain(`jq -r '.entries[] | "\\(.tag) \\(.when)"' /drizzle/meta/_journal.json`);
    expect(executableLines).toContain('while read -r tag when; do');
  });

  it('fails the build when the ledger high-water mark is not the newest journal when', () => {
    expect(executableLines).toContain(
      'ledger_max=$(gosu postgres psql -h /var/run/postgresql main -t -A -c "SELECT COALESCE(max(created_at), 0) FROM drizzle.\\"__drizzle_migrations\\"")',
    );
    expect(executableLines).toContain(`journal_max=$(jq -r '[.entries[].when] | max' /drizzle/meta/_journal.json)`);
    expect(executableLines).toContain('if [ "$ledger_max" != "$journal_max" ]; then');
  });
});
