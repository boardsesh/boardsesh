import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLE_CONFIGS, TABLE_INVALIDATE_KEYS } from '@boardsesh/offline-sync';

/**
 * The guard for a bug class that shipped silently and stayed shipped: a sync or
 * mutation-drain invalidation key that **no reader uses**. `TABLE_CONFIGS` used
 * to bust `['ticks']`, `['playlists']`, `['favorites']`, `['setterFollows']` and
 * `['playlistFollows']`, and the mutation drainer carried a near-duplicate map
 * with the same dead keys — so a completed user-data pull refreshed almost
 * nothing, and nothing failed.
 *
 * This test scans the real source tree for query keys and asserts every mapped
 * key is a prefix of one, plus that every consumer imports the single map rather
 * than declaring a second copy. The third consumer is mobile's live climb-stat
 * write-through (issue #5227), which refreshes the same board_climb_stats keys
 * from the stream instead of from a completed pull.
 *
 * It lives in the mobile project because that is where most of the readers live,
 * and it anchors on `import.meta.url` (not `process.cwd()`) so a different
 * runner cwd cannot quietly turn it into a no-op — the file count is asserted
 * non-zero for the same reason.
 */

const SCAN_ROOTS = ['../../app', '../../src', '../../../shared'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const SKIP_DIRECTORIES = new Set(['node_modules', '__tests__', 'dist', 'build', 'generated', '.expo']);

function collectSourceFiles(directory: string, collected: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = `${directory}/${entry}`;
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectSourceFiles(fullPath, collected);
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    // The three map consumers would otherwise vouch for their own keys.
    if (
      entry === 'invalidate-keys.ts' ||
      entry === 'table-config.ts' ||
      entry === 'drainer.ts' ||
      entry === 'climb-stats-live-sync.ts'
    ) {
      continue;
    }
    collected.push(fullPath);
  }
}

const scannedFiles: string[] = [];
for (const root of SCAN_ROOTS) {
  collectSourceFiles(fileURLToPath(new URL(root, import.meta.url)), scannedFiles);
}

/**
 * First segments of array literals that start with a string. A leading `[` that
 * follows an identifier, `]`, `)` or a quote is a type/element **index**
 * (`GetTicksQueryResponse['ticks']`), not an array literal — excluding those is
 * what keeps a dead key from vouching for itself via a type expression.
 */
const ARRAY_LITERAL_HEAD = /(^|[^\w\]')")`])\[\s*(['"`])([A-Za-z][\w.-]*)\2/g;

const readerKeySegments = new Set<string>();
for (const filePath of scannedFiles) {
  const source = readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(ARRAY_LITERAL_HEAD)) {
    readerKeySegments.add(match[3]);
  }
}

describe('invalidation-key drift', () => {
  it('actually scanned the source tree', () => {
    // An empty scan would make every assertion below pass vacuously.
    expect(scannedFiles.length).toBeGreaterThan(200);
    expect(readerKeySegments.size).toBeGreaterThan(20);
  });

  it('maps every key to a query key a reader really uses', () => {
    const orphans: string[] = [];
    for (const [tableName, keys] of Object.entries(TABLE_INVALIDATE_KEYS)) {
      for (const key of keys) {
        const firstSegment = key[0];
        if (!readerKeySegments.has(firstSegment)) orphans.push(`${tableName} → ['${firstSegment}']`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('covers every syncable table, so a new table cannot skip the UI refresh', () => {
    const unmapped = Object.keys(TABLE_CONFIGS).filter((tableName) => !(tableName in TABLE_INVALIDATE_KEYS));
    expect(unmapped).toEqual([]);
  });

  it('feeds TABLE_CONFIGS from the same map, with no second copy', () => {
    for (const [tableName, config] of Object.entries(TABLE_CONFIGS)) {
      expect(config.invalidateKeys).toBe(TABLE_INVALIDATE_KEYS[tableName]);
    }
  });

  it('keeps every consumer importing the shared map rather than declaring their own', () => {
    const tableConfigSource = readFileSync(
      fileURLToPath(new URL('../../../shared/offline-sync/src/sync/table-config.ts', import.meta.url)),
      'utf8',
    );
    const drainerSource = readFileSync(
      fileURLToPath(new URL('../../../shared/offline-sync/src/mutation-queue/drainer.ts', import.meta.url)),
      'utf8',
    );
    const liveStatsSource = readFileSync(
      fileURLToPath(new URL('../offline/climb-stats-live-sync.ts', import.meta.url)),
      'utf8',
    );
    expect(tableConfigSource).toContain("from './invalidate-keys'");
    expect(drainerSource).toContain("from '../sync/invalidate-keys'");
    expect(liveStatsSource).toContain('invalidateKeysForTable');
    expect(liveStatsSource).toContain("from '@boardsesh/offline-sync'");
    // A `keyMap`/`invalidateKeys:` literal reappearing in either file is exactly
    // the duplication this consolidation removed.
    expect(drainerSource).not.toMatch(/const keyMap: Record<string, string\[]\[]>/);
    expect(tableConfigSource).not.toMatch(/^\s+invalidateKeys: \[/m);
    // The live consumer must not hand-roll the stats key list either. It names
    // only the ['climb'] root, to narrow that one invalidation by climb uuid.
    for (const rootKey of ['searchClimbs', 'infiniteSearchClimbs', 'searchClimbsCount']) {
      expect(liveStatsSource).not.toContain(`'${rootKey}'`);
    }
  });
});
