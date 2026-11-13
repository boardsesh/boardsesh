/**
 * Re-emit the per-board hole-placement shards + loader from the data already
 * committed in `src/generated/hole-placements/`, without touching the database.
 *
 * `generate-board-constants.ts` is the source of truth for the shard format, but
 * it queries Postgres. When only the *file layout* changes (splitting the
 * all-boards `HOLE_PLACEMENTS` record into per-board `.cjs` shards) and the data
 * itself is unchanged, this script reproduces the exact same output the
 * generator would emit by reusing its emit helpers — so the committed shards stay
 * byte-for-byte identical to a real DB regeneration.
 *
 * Usage:
 *   node --import tsx scripts/reshard-hole-placements.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldTuple } from '../src/types';
import {
  BOARD_NAMES,
  generateHolePlacementsLoaderFile,
  generateHolePlacementsShard,
  HOLE_PLACEMENTS_LOADER_PATH,
  HOLE_PLACEMENTS_SHARD_DIR,
  type GeneratedBoardName,
  type HolePlacement,
} from './generate-board-constants';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const COMMITTED_DATA_PATH = join(__dirname, '../src/generated/product-sizes-data.ts');

/**
 * Flatten the grouped `{ 'layout-set': HoldTuple[] }` shape back into the flat
 * `HolePlacement[]` rows the generator's emit helper expects, preserving order so
 * the regenerated shard matches a DB run.
 */
function flattenBoard(boardName: BoardName, grouped: Record<string, HoldTuple[]>): HolePlacement[] {
  const rows: HolePlacement[] = [];
  for (const [layoutSetKey, holds] of Object.entries(grouped)) {
    const [layoutId, setId] = layoutSetKey.split('-').map((part) => parseInt(part, 10));
    for (const [placementId, mirroredPlacementId, x, y] of holds) {
      rows.push({ placementId, mirroredPlacementId, x, y, setId, layoutId });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  // Import the committed data lazily so this script doesn't depend on the DB.
  const { HOLE_PLACEMENTS } = (await import('../src/hole-placements')) as {
    HOLE_PLACEMENTS: Record<BoardName, Record<string, HoldTuple[]>>;
  };

  mkdirSync(HOLE_PLACEMENTS_SHARD_DIR, { recursive: true });

  for (const boardName of BOARD_NAMES as readonly GeneratedBoardName[]) {
    const grouped = HOLE_PLACEMENTS[boardName] ?? {};
    const rows = flattenBoard(boardName, grouped);
    const shardPath = join(HOLE_PLACEMENTS_SHARD_DIR, `${boardName}.cjs`);
    writeFileSync(shardPath, generateHolePlacementsShard(boardName, rows), 'utf-8');
    console.info(`Wrote ${shardPath} (${rows.length} holds)`);
  }

  writeFileSync(HOLE_PLACEMENTS_LOADER_PATH, generateHolePlacementsLoaderFile(), 'utf-8');
  console.info(`Wrote ${HOLE_PLACEMENTS_LOADER_PATH}`);

  rewriteCommittedProductFile();
  console.info(`Rewrote ${COMMITTED_DATA_PATH} as geometry-free catalog metadata`);
}

/** Keep generated catalog metadata independent of the hold-placement loader. */
function rewriteCommittedProductFile(): void {
  const original = readFileSync(COMMITTED_DATA_PATH, 'utf-8');
  const holePlacementsStart = original.indexOf('\nexport const HOLE_PLACEMENTS');
  let metadata = holePlacementsStart === -1 ? original : original.slice(0, holePlacementsStart);
  metadata = metadata.replace(
    /\/\/ Hole placements are sharded[\s\S]*?export \{ HOLE_PLACEMENTS \} from '\.\.\/hole-placements';\n\n/,
    '',
  );
  metadata = metadata.replace(
    "import type { HoldTuple, LayoutData, ProductSizeData, SetData } from '../types';",
    "import type { LayoutData, ProductSizeData, SetData } from '../types';",
  );
  if (metadata !== original) writeFileSync(COMMITTED_DATA_PATH, `${metadata.trimEnd()}\n`, 'utf-8');
}

void main();
