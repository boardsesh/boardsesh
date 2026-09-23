import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { placeImports } from '../src/schema/app/places.js';
import { parsePlacesSource } from './places-import-helpers.js';
import { importPlaceRows, PLACE_DATASET } from '../src/queries/places/import.js';

const SOURCE_URL = 'https://download.geonames.org/export/dump/';

async function main() {
  const { values: options } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: { 'if-empty': { type: 'boolean', default: false }, 'source-dir': { type: 'string' } },
  });
  const ifEmpty = options['if-empty'];
  const sourceDir =
    options['source-dir'] === undefined
      ? null
      : path.resolve(process.env.INIT_CWD ?? process.cwd(), options['source-dir']);
  const { db, close } = createScriptDb();
  let downloadDir: string | null = null;
  try {
    if (ifEmpty) {
      const [completedImport] = await db
        .select()
        .from(placeImports)
        .where(eq(placeImports.dataset, PLACE_DATASET))
        .limit(1);
      if (completedImport) {
        console.info(`Place index already imported (${completedImport.rowCount} places).`);
        return;
      }
    }
    const sources: (typeof placeImports.$inferInsert)['sources'] = [];
    const contents = new Map<string, string>();
    if (!sourceDir) downloadDir = await mkdtemp(path.join(tmpdir(), 'boardsesh-places-'));
    for (const name of ['cities500.txt', 'countryInfo.txt', 'admin1CodesASCII.txt']) {
      if (sourceDir) {
        const sourcePath = path.join(sourceDir, name);
        const bytes = await readFile(sourcePath);
        sources.push({
          name,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          modifiedAt: (await stat(sourcePath)).mtime.toISOString(),
        });
        contents.set(name, bytes.toString('utf8'));
      } else {
        const remoteName = name === 'cities500.txt' ? 'cities500.zip' : name;
        const response = await fetch(`${SOURCE_URL}${remoteName}`, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`GeoNames ${remoteName}: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        sources.push({
          name: remoteName,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          modifiedAt: response.headers.get('last-modified'),
        });
        if (remoteName.endsWith('.zip')) {
          const archivePath = path.join(downloadDir!, remoteName);
          await writeFile(archivePath, bytes);
          // Only extract the known member, never arbitrary archive paths.
          await promisify(execFile)('unzip', ['-q', archivePath, name, '-d', downloadDir!]);
          contents.set(name, await readFile(path.join(downloadDir!, name), 'utf8'));
        } else contents.set(name, bytes.toString('utf8'));
      }
    }
    const rows = parsePlacesSource(
      contents.get('cities500.txt')!,
      contents.get('countryInfo.txt')!,
      contents.get('admin1CodesASCII.txt')!,
    );
    await importPlaceRows(db, rows, sources, ifEmpty);
    console.info(`Imported ${rows.length} GeoNames places. Existing places and gyms were retained.`);
  } finally {
    await close();
    if (downloadDir) await rm(downloadDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Place import failed');
  process.exitCode = 1;
});
