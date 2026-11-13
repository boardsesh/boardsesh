import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact published0312 source at 6a53e3286553a40a9196e76caafdfc7b5ce38896.
 * This historical proof is never an alternative current-canonical bootstrap. */
export const HISTORICAL_CREDENTIAL_FIXTURE = Object.freeze({
  profile: 'historical-private-browser-v1',
  count: 313,
  lastTag: '0312_browser_selection_possession',
  lastWhen: 1794567827730,
  journalSha256: 'ed600748d4863fa4dd7c7a4286041db19c1738085d57410554893d7916a4b5c8',
  migrationSetSha256: '0e32ca2c7e0071b5404fbca9ae5e852d5a0af3a1c9a03019268595032007ae06',
});
const canonicalDirectory = fileURLToPath(new URL('../../../../../../db/drizzle/', import.meta.url));
const sha256 = (source: string | Buffer) => createHash('sha256').update(source).digest('hex');
interface HistoricalEntry {
  readonly tag: string;
  readonly when: number;
}
export async function readHistoricalCredentialWriterMigrations(directory = canonicalDirectory) {
  const parsed: unknown = JSON.parse(await readFile(join(directory, 'meta', '_journal.json'), 'utf8'));
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length < HISTORICAL_CREDENTIAL_FIXTURE.count
  )
    throw new Error('HISTORICAL_CREDENTIAL_JOURNAL_PROVENANCE_MISMATCH');
  const journal = JSON.stringify(
    { ...parsed, entries: parsed.entries.slice(0, HISTORICAL_CREDENTIAL_FIXTURE.count) },
    null,
    2,
  );
  if (sha256(journal) !== HISTORICAL_CREDENTIAL_FIXTURE.journalSha256)
    throw new Error('HISTORICAL_CREDENTIAL_JOURNAL_PROVENANCE_MISMATCH');
  // The fixed digest authenticates the complete structure before paths are read.
  const entries = parsed.entries.slice(0, HISTORICAL_CREDENTIAL_FIXTURE.count) as HistoricalEntry[];
  const last = entries.at(-1);
  if (last?.tag !== HISTORICAL_CREDENTIAL_FIXTURE.lastTag || last.when !== HISTORICAL_CREDENTIAL_FIXTURE.lastWhen)
    throw new Error('HISTORICAL_CREDENTIAL_JOURNAL_PROVENANCE_MISMATCH');
  const migrations = await Promise.all(
    entries.map(async (entry) => {
      const bytes = await readFile(join(directory, `${entry.tag}.sql`));
      const contents = bytes.toString('utf8');
      if (!Buffer.from(contents, 'utf8').equals(bytes))
        throw new Error('HISTORICAL_CREDENTIAL_MIGRATION_PROVENANCE_MISMATCH');
      return Object.freeze({ ...entry, hash: sha256(bytes), contents });
    }),
  );
  const manifest = migrations.map(({ tag, when, hash }) => ({ tag, when, hash }));
  if (sha256(JSON.stringify(manifest)) !== HISTORICAL_CREDENTIAL_FIXTURE.migrationSetSha256)
    throw new Error('HISTORICAL_CREDENTIAL_MIGRATION_PROVENANCE_MISMATCH');
  return Object.freeze({
    journal,
    migrations: Object.freeze(migrations),
    ledger: Object.freeze(migrations.map(({ hash, when }) => Object.freeze({ hash, created_at: String(when) }))),
  });
}

/** Copies only verified, immutable source bytes into an existing empty owned
 * temporary directory. There is no configurable migration number or cutoff. */
export async function materializeHistoricalCredentialWriterMigrations(
  outputDirectory: string,
  sourceDirectory = canonicalDirectory,
) {
  const source = await readHistoricalCredentialWriterMigrations(sourceDirectory);
  const output = await lstat(outputDirectory);
  if (!output.isDirectory() || output.isSymbolicLink() || (await readdir(outputDirectory)).length)
    throw new Error('HISTORICAL_CREDENTIAL_EMPTY_OUTPUT_REQUIRED');
  await mkdir(join(outputDirectory, 'meta'));
  await writeFile(join(outputDirectory, 'meta', '_journal.json'), source.journal, { flag: 'wx' });
  await Promise.all(
    source.migrations.map((migration) =>
      writeFile(join(outputDirectory, `${migration.tag}.sql`), migration.contents, { flag: 'wx' }),
    ),
  );
}
