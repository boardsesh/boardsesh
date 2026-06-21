/**
 * Re-emit the per-board hole-placement shards + loader from the data already
 * committed in `src/generated/product-sizes-data.ts`, without touching the
 * database.
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
  const { HOLE_PLACEMENTS } = (await import(COMMITTED_DATA_PATH)) as {
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
  console.info(`Rewrote ${COMMITTED_DATA_PATH} to re-export HOLE_PLACEMENTS from the lazy loader`);
}

/**
 * Strip the now-sharded inline `HOLE_PLACEMENTS` block out of the committed
 * `product-sizes-data.ts` and replace it with a re-export from the lazy loader,
 * matching exactly what `generateProductDataFile` emits on a fresh DB run. This
 * is a deterministic transform of a generated file, not a hand-edit.
 */
function rewriteCommittedProductFile(): void {
  const original = readFileSync(COMMITTED_DATA_PATH, 'utf-8');

  // Already migrated (re-exports from the loader instead of inlining) — nothing
  // to do. Keeps the script idempotent so it can be re-run safely.
  if (original.includes("export { HOLE_PLACEMENTS } from '../hole-placements';")) {
    console.info(`${COMMITTED_DATA_PATH} already re-exports HOLE_PLACEMENTS; leaving as-is`);
    return;
  }

  // Drop everything from the inline HOLE_PLACEMENTS export to the end of file.
  const holePlacementsStart = original.indexOf('\nexport const HOLE_PLACEMENTS');
  if (holePlacementsStart === -1) {
    throw new Error('Could not find inline HOLE_PLACEMENTS export to remove and file is not already migrated.');
  }
  let trimmed = original.slice(0, holePlacementsStart).replace(/\s+$/, '');

  // `HoldTuple` was only used by the inline HOLE_PLACEMENTS record; drop it from
  // the type import so the file does not carry an unused import.
  trimmed = trimmed.replace(
    "import type { HoldTuple, LayoutData, ProductSizeData, SetData } from '../types';",
    "import type { LayoutData, ProductSizeData, SetData } from '../types';",
  );

  // Re-export the lazy all-boards record after the type imports so existing
  // `import { HOLE_PLACEMENTS } from './generated/product-sizes-data'` keeps
  // working.
  trimmed = trimmed.replace(
    "import type { LayoutData, ProductSizeData, SetData } from '../types';",
    `import type { LayoutData, ProductSizeData, SetData } from '../types';

// Hole placements are sharded per board and loaded lazily so Hermes only ever
// evaluates the active board's holds. The all-boards \`HOLE_PLACEMENTS\` record is
// re-exported here for backwards compatibility (Node-side consumers that iterate
// every board), but it is a lazy proxy — touching a board key requires only that
// board's shard.
export { HOLE_PLACEMENTS } from '../hole-placements';`,
  );

  writeFileSync(COMMITTED_DATA_PATH, `${trimmed}\n`, 'utf-8');
}

void main();
