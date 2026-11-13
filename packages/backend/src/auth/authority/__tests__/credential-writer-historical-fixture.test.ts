import assert from 'node:assert/strict';
import { afterEach, it as test } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORICAL_CREDENTIAL_FIXTURE,
  materializeHistoricalCredentialWriterMigrations,
  readHistoricalCredentialWriterMigrations,
} from './fixtures/credential-writer-historical-fixture';

const directories: string[] = [];
const canonicalDirectory = fileURLToPath(new URL('../../../../../db/drizzle/', import.meta.url));
const sha256 = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex');
async function ownedDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'epic6975-historical-credential-'));
  directories.push(directory);
  return directory;
}
async function materializedDirectory() {
  const directory = await ownedDirectory();
  await materializeHistoricalCredentialWriterMigrations(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('pins the exact published0312 journal, length, terminal entry and complete SQL bytes', async () => {
  const historical = await readHistoricalCredentialWriterMigrations();
  assert.equal(historical.ledger.length, 313);
  assert.equal(historical.migrations.at(-1)?.tag, '0312_browser_selection_possession');
  assert.equal(historical.migrations.at(-1)?.when, 1794567827730);
  assert.equal(sha256(historical.journal), HISTORICAL_CREDENTIAL_FIXTURE.journalSha256);
  assert.equal(
    sha256(JSON.stringify(historical.migrations.map(({ tag, when, hash }) => ({ tag, when, hash })))),
    HISTORICAL_CREDENTIAL_FIXTURE.migrationSetSha256,
  );
});

test('materializes only313 original migrations and leaves the current appended canonical source unchanged', async () => {
  const canonicalBefore = await readFile(join(canonicalDirectory, 'meta', '_journal.json'));
  const directory = await materializedDirectory();
  const copied = await readHistoricalCredentialWriterMigrations(directory);
  assert.equal(copied.migrations.length, 313);
  for (const migration of copied.migrations)
    assert.equal(sha256(await readFile(join(directory, `${migration.tag}.sql`))), migration.hash);
  await assert.rejects(readFile(join(directory, '0313_provider_security_receipts.sql')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(canonicalDirectory, 'meta', '_journal.json')), canonicalBefore);
});

test('refuses a changed historical SQL file even with the original journal and names', async () => {
  const directory = await materializedDirectory();
  await writeFile(join(directory, '0312_browser_selection_possession.sql'), '-- altered historical source\n');
  await assert.rejects(readHistoricalCredentialWriterMigrations(directory), /MIGRATION_PROVENANCE_MISMATCH/);
});

test('refuses a changed historical timestamp instead of treating the terminal name as sufficient provenance', async () => {
  const directory = await materializedDirectory();
  const journal = JSON.parse(await readFile(join(directory, 'meta', '_journal.json'), 'utf8')) as {
    entries: { when: number }[];
  };
  const first = journal.entries[0];
  assert.ok(first);
  first.when += 1;
  await writeFile(join(directory, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  await assert.rejects(readHistoricalCredentialWriterMigrations(directory), /JOURNAL_PROVENANCE_MISMATCH/);
});

test('refuses a shortened historical prefix', async () => {
  const directory = await materializedDirectory();
  const journal = JSON.parse(await readFile(join(directory, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  journal.entries.pop();
  await writeFile(join(directory, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  await assert.rejects(readHistoricalCredentialWriterMigrations(directory), /JOURNAL_PROVENANCE_MISMATCH/);
});

test('refuses a nonempty output without overwriting its existing files', async () => {
  const directory = await ownedDirectory();
  await writeFile(join(directory, 'sentinel'), 'owned-existing-file');
  await assert.rejects(materializeHistoricalCredentialWriterMigrations(directory), /EMPTY_OUTPUT_REQUIRED/);
  assert.equal(await readFile(join(directory, 'sentinel'), 'utf8'), 'owned-existing-file');
});

test('refuses an output directory symlink rather than following it', async () => {
  const parent = await ownedDirectory();
  const target = await ownedDirectory();
  const pointer = join(parent, 'pointer');
  await symlink(target, pointer, 'dir');
  await assert.rejects(materializeHistoricalCredentialWriterMigrations(pointer), /EMPTY_OUTPUT_REQUIRED/);
});
