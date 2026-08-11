/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * File-text guard for #4211.
 *
 * The `boardsesh-dev-db` image applies the migration journal itself and writes
 * drizzle's ledger by hand. It used to stamp `created_at` with the image's build
 * clock, which becomes a high-water mark drizzle's applier can never clear — so
 * every migration written after the image was built is silently skipped on that
 * database, forever.
 *
 * Building the image to check this takes tens of minutes and hits the network
 * hard (six APK downloads, pgloader, the MoonBoard import), so the practical
 * coverage is this text guard — over the applier script and the Dockerfile that
 * calls it — plus the in-build assertion it requires: the ledger's high-water
 * mark must equal the journal's newest `when`.
 *
 * The applier's own behaviour is covered against a modelled psql in
 * `packages/db/docker/apply-drizzle-migrations.test.sh`.
 */
const DOCKERFILE_PATH = 'packages/db/docker/Dockerfile.dev-db';
const APPLIER_PATH = 'packages/db/docker/apply-drizzle-migrations.sh';

/** Non-comment lines only — the `date +%s` ban must not be satisfiable by a comment. */
const executableLinesOf = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

const dockerfileLines = executableLinesOf(DOCKERFILE_PATH);
const applierLines = executableLinesOf(APPLIER_PATH);

describe('dev-db image migration ledger', () => {
  it('never stamps ledger rows with the build clock', () => {
    const ledgerInserts = [...dockerfileLines.split('\n'), ...applierLines.split('\n')].filter(
      (line) => line.includes('INSERT INTO') && line.includes('__drizzle_migrations'),
    );
    expect(ledgerInserts.length).toBeGreaterThan(0);
    for (const insert of ledgerInserts) {
      expect(insert).not.toContain('date +%s');
      expect(insert).toContain('$journal_created_at');
    }
  });

  it('reads the when of each entry out of the journal', () => {
    expect(applierLines).toContain(`jq -er '.entries[] | [.tag, .when] | @tsv' "$JOURNAL_FILE"`);
    expect(applierLines).toContain("while IFS=$'\\t' read -r tag journal_created_at; do");
  });

  it('fails the build when the ledger high-water mark is not the newest journal when', () => {
    expect(dockerfileLines).toContain(
      'ledger_max=$(gosu postgres psql -h /var/run/postgresql main -t -A -c "SELECT COALESCE(max(created_at), 0) FROM drizzle.\\"__drizzle_migrations\\"")',
    );
    expect(dockerfileLines).toContain(`journal_max=$(jq -r '[.entries[].when] | max' /drizzle/meta/_journal.json)`);
    expect(dockerfileLines).toContain('if [ "$ledger_max" != "$journal_max" ]; then');
  });
});
