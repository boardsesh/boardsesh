/**
 * Generate shared board constants from the development database.
 *
 * Usage:
 *   bun run --filter=@boardsesh/board-constants generate
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const ENV_PATHS = [
  join(__dirname, '../.env.local'),
  join(__dirname, '../../web/.env.local'),
  join(__dirname, '../../backend/.env.development'),
];

for (const envPath of ENV_PATHS) {
  if (existsSync(envPath)) {
    config({ path: envPath, override: false });
  }
}

type PostgresConfig = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
};

type ProductSize = {
  id: number;
  name: string;
  description: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  productId: number;
};

type Layout = {
  id: number;
  name: string;
  productId: number;
};

type SetMapping = {
  setId: number;
  setName: string;
  layoutId: number;
  sizeId: number;
};

type ImageFilenameMapping = {
  layoutId: number;
  sizeId: number;
  setId: number;
  imageFilename: string;
};

type LedPlacement = {
  placementId: number;
  position: number;
  layoutId: number;
  sizeId: number;
};

type HolePlacement = {
  placementId: number;
  mirroredPlacementId: number | null;
  x: number;
  y: number;
  setId: number;
  layoutId: number;
};

type GeneratedBoardData = {
  sizes: ProductSize[];
  layouts: Layout[];
  sets: SetMapping[];
  imageFilenames: ImageFilenameMapping[];
  ledPlacements: LedPlacement[];
  holePlacements: HolePlacement[];
};

const BOARD_NAMES = ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'] as const;
type GeneratedBoardName = (typeof BOARD_NAMES)[number];

const PRODUCT_OUTPUT_PATH = join(__dirname, '../src/generated/product-sizes-data.ts');
const LED_OUTPUT_PATH = join(__dirname, '../src/generated/led-placements-data.ts');
const HOLE_PLACEMENTS_LOADER_PATH = join(__dirname, '../src/hole-placements.ts');
const HOLE_PLACEMENTS_SHARD_DIR = join(__dirname, '../src/generated/hole-placements');

function getPostgresConfig(): PostgresConfig {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (connectionString) {
    const url = new URL(connectionString);
    return {
      host: url.hostname || process.env.POSTGRES_HOST || 'localhost',
      port: url.port || process.env.POSTGRES_PORT || '5432',
      user: decodeURIComponent(url.username || process.env.POSTGRES_USER || 'postgres'),
      password: decodeURIComponent(url.password || process.env.POSTGRES_PASSWORD || 'password'),
      database: url.pathname.replace(/^\//, '') || process.env.POSTGRES_DATABASE || 'main',
    };
  }

  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || '5432',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'password',
    database: process.env.POSTGRES_DATABASE || 'main',
  };
}

const postgresConfig = getPostgresConfig();

function runPsqlQuery(query: string): string {
  return execFileSync(
    'psql',
    [
      '-h',
      postgresConfig.host,
      '-p',
      postgresConfig.port,
      '-U',
      postgresConfig.user,
      '-d',
      postgresConfig.database,
      '-t',
      '-A',
      '-F',
      '|',
      '-R',
      '~~~',
      '-c',
      query,
    ],
    {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PGPASSWORD: postgresConfig.password,
      },
    },
  );
}

function parseRows<T>(result: string, mapRow: (parts: string[]) => T): T[] {
  return result
    .trim()
    .split('~~~')
    .filter((line) => line.length > 0 && !line.startsWith('\n'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => mapRow(line.split('|')));
}

function querySizes(boardName: GeneratedBoardName): ProductSize[] {
  const result = runPsqlQuery(
    `SELECT id, REPLACE(name, E'\\n', ' '), COALESCE(REPLACE(description, E'\\n', ' '), ''), edge_left, edge_right, edge_bottom, edge_top, product_id FROM board_product_sizes WHERE board_type = '${boardName}' ORDER BY id;`,
  );

  return parseRows(result, ([id, name, description, edgeLeft, edgeRight, edgeBottom, edgeTop, productId]) => ({
    id: parseInt(id, 10),
    name: name.trim(),
    description: description.trim(),
    edgeLeft: parseInt(edgeLeft, 10),
    edgeRight: parseInt(edgeRight, 10),
    edgeBottom: parseInt(edgeBottom, 10),
    edgeTop: parseInt(edgeTop, 10),
    productId: parseInt(productId, 10),
  }));
}

function queryLayouts(boardName: GeneratedBoardName): Layout[] {
  const result = runPsqlQuery(
    `SELECT id, REPLACE(name, E'\\n', ' '), product_id FROM board_layouts WHERE board_type = '${boardName}' AND is_listed = true AND password IS NULL ORDER BY id;`,
  );

  return parseRows(result, ([id, name, productId]) => ({
    id: parseInt(id, 10),
    name: name.trim(),
    productId: parseInt(productId, 10),
  }));
}

// Skip PSLS rows whose (layout_id, set_id) combo has no rows in board_placements.
// Aurora occasionally publishes a set in board_product_sizes_layouts_sets without
// publishing the corresponding placements (e.g. tension's "Wood Expansion" / "Plastic
// Expansion" sets — listed in PSLS but no holds on any layout). Without this filter,
// those sets show up as selectable options that render an empty board.
const HAS_PLACEMENTS_CLAUSE = `AND EXISTS (
  SELECT 1 FROM board_placements p
  WHERE p.board_type = psls.board_type
    AND p.set_id = psls.set_id
    AND p.layout_id = psls.layout_id
)`;

function querySets(boardName: GeneratedBoardName): SetMapping[] {
  const result = runPsqlQuery(
    `SELECT sets.id, REPLACE(sets.name, E'\\n', ' '), psls.layout_id, psls.product_size_id FROM board_sets sets INNER JOIN board_product_sizes_layouts_sets psls ON sets.board_type = psls.board_type AND sets.id = psls.set_id WHERE sets.board_type = '${boardName}' ${HAS_PLACEMENTS_CLAUSE} ORDER BY psls.layout_id, psls.product_size_id, sets.id;`,
  );

  return parseRows(result, ([setId, setName, layoutId, sizeId]) => ({
    setId: parseInt(setId, 10),
    setName: setName.trim(),
    layoutId: parseInt(layoutId, 10),
    sizeId: parseInt(sizeId, 10),
  }));
}

function queryImageFilenames(boardName: GeneratedBoardName): ImageFilenameMapping[] {
  const result = runPsqlQuery(
    `SELECT psls.layout_id, psls.product_size_id, psls.set_id, psls.image_filename FROM board_product_sizes_layouts_sets psls WHERE psls.board_type = '${boardName}' AND psls.image_filename IS NOT NULL ${HAS_PLACEMENTS_CLAUSE} ORDER BY psls.layout_id, psls.product_size_id, psls.set_id;`,
  );

  return parseRows(result, ([layoutId, sizeId, setId, imageFilename]) => ({
    layoutId: parseInt(layoutId, 10),
    sizeId: parseInt(sizeId, 10),
    setId: parseInt(setId, 10),
    imageFilename: imageFilename.trim(),
  }));
}

function queryLedPlacements(boardName: GeneratedBoardName): LedPlacement[] {
  const result = runPsqlQuery(
    `SELECT placements.id, leds.position, placements.layout_id, leds.product_size_id FROM board_placements placements INNER JOIN board_leds leds ON placements.board_type = leds.board_type AND placements.hole_id = leds.hole_id WHERE placements.board_type = '${boardName}' ORDER BY placements.layout_id, leds.product_size_id, placements.id;`,
  );

  return parseRows(result, ([placementId, position, layoutId, sizeId]) => ({
    placementId: parseInt(placementId, 10),
    position: parseInt(position, 10),
    layoutId: parseInt(layoutId, 10),
    sizeId: parseInt(sizeId, 10),
  }));
}

function queryHolePlacements(boardName: GeneratedBoardName): HolePlacement[] {
  const result = runPsqlQuery(
    `SELECT placements.id, mirrored_placements.id, holes.x, holes.y, placements.set_id, placements.layout_id FROM board_holes holes INNER JOIN board_placements placements ON placements.board_type = holes.board_type AND placements.hole_id = holes.id LEFT JOIN board_placements mirrored_placements ON mirrored_placements.board_type = holes.board_type AND mirrored_placements.hole_id = holes.mirrored_hole_id AND mirrored_placements.set_id = placements.set_id AND mirrored_placements.layout_id = placements.layout_id WHERE holes.board_type = '${boardName}' ORDER BY placements.layout_id, placements.set_id, placements.id;`,
  );

  return parseRows(result, ([placementId, mirroredId, x, y, setId, layoutId]) => ({
    placementId: parseInt(placementId, 10),
    mirroredPlacementId: mirroredId ? parseInt(mirroredId, 10) : null,
    x: parseInt(x, 10),
    y: parseInt(y, 10),
    setId: parseInt(setId, 10),
    layoutId: parseInt(layoutId, 10),
  }));
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function assertBoardDataIsComplete(boardName: GeneratedBoardName, data: GeneratedBoardData): void {
  const missing: string[] = [];

  if (data.sizes.length === 0) missing.push('product sizes');
  if (data.layouts.length === 0) missing.push('layouts');
  if (data.sets.length === 0) missing.push('set mappings');
  if (data.imageFilenames.length === 0) missing.push('image filenames');
  if (data.ledPlacements.length === 0) missing.push('LED placements');
  if (data.holePlacements.length === 0) missing.push('hole placements');

  if (missing.length > 0) {
    throw new Error(
      `Refusing to generate board constants with incomplete ${boardName} data. Missing: ${missing.join(', ')}.`,
    );
  }
}

function generateSizesTypeScript(boardName: GeneratedBoardName, sizes: ProductSize[]): string {
  const entries = sizes
    .map(
      (size) =>
        `    ${size.id}: { id: ${size.id}, name: '${escapeString(size.name)}', description: '${escapeString(size.description)}', edgeLeft: ${size.edgeLeft}, edgeRight: ${size.edgeRight}, edgeBottom: ${size.edgeBottom}, edgeTop: ${size.edgeTop}, productId: ${size.productId} },`,
    )
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateLayoutsTypeScript(boardName: GeneratedBoardName, layouts: Layout[]): string {
  const entries = layouts
    .map(
      (layout) =>
        `    ${layout.id}: { id: ${layout.id}, name: '${escapeString(layout.name)}', productId: ${layout.productId} },`,
    )
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateSetsTypeScript(boardName: GeneratedBoardName, sets: SetMapping[]): string {
  const grouped: Record<string, Array<{ id: number; name: string }>> = {};

  for (const set of sets) {
    const key = `${set.layoutId}-${set.sizeId}`;
    grouped[key] ??= [];
    grouped[key].push({ id: set.setId, name: set.setName });
  }

  const entries = Object.entries(grouped)
    .map(([key, setList]) => {
      const setArray = setList.map((set) => `{ id: ${set.id}, name: '${escapeString(set.name)}' }`).join(', ');
      return `    '${key}': [${setArray}],`;
    })
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateImageFilenamesTypeScript(boardName: GeneratedBoardName, mappings: ImageFilenameMapping[]): string {
  const entries = mappings
    .map(
      (mapping) =>
        `    '${mapping.layoutId}-${mapping.sizeId}-${mapping.setId}': '${escapeString(mapping.imageFilename)}',`,
    )
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

/**
 * Build one per-board CommonJS hole-placement shard.
 *
 * Hole placements are the heavy slice of the board constants (~200 KB of the
 * ~240 KB product-sizes file). On Hermes (Android, no JIT) the first synchronous
 * evaluation of an all-boards record blocks the JS thread long enough to freeze
 * the app when a board surface mounts. Emitting one shard per board lets the
 * loader (`hole-placements.ts`) `require()` only the active board, so Hermes only
 * ever evaluates ~30–40 KB.
 *
 * Shards are `.cjs` (not `.ts`) on purpose: a literal `require('./<board>.cjs')`
 * resolves and defers evaluation identically in Metro, webpack, tsx, and the
 * vitest node runtime, whereas a bare `require()` of a `.ts` file fails under
 * vitest (Node's CJS require has no TypeScript loader). The data is generated and
 * never hand-edited, so it carries no inline types; the loader annotates the
 * return type instead.
 *
 * The body is emitted one hold tuple per line — the exact shape Oxfmt/Prettier
 * produces — so the generated `.cjs` shards pass `vp check` unchanged (the
 * formatter does not honour the generated-dir ignore glob for `.cjs` the way it
 * does for the generated `.ts` files) and stay byte-stable across regenerations.
 */
function generateHolePlacementsShard(boardName: GeneratedBoardName, placements: HolePlacement[]): string {
  const grouped: Record<string, Array<[number, number | null, number, number]>> = {};

  for (const placement of placements) {
    const key = `${placement.layoutId}-${placement.setId}`;
    grouped[key] ??= [];
    grouped[key].push([placement.placementId, placement.mirroredPlacementId, placement.x, placement.y]);
  }

  const entries = Object.entries(grouped)
    .map(([key, holds]) => {
      const holdLines = holds
        .map(([id, mirrorId, x, y]) => `    [${id}, ${mirrorId === null ? 'null' : mirrorId}, ${x}, ${y}],`)
        .join('\n');
      return `  '${key}': [\n${holdLines}\n  ],`;
    })
    .join('\n');

  return `// ⚠️ DO NOT EDIT THIS FILE MANUALLY ⚠️
// Auto-generated per-board hole placements for the '${boardName}' board.
// Re-run: bun run --filter=@boardsesh/board-constants generate
// Loaded lazily (one board at a time) by ../../hole-placements.ts.
/** @type {Record<string, Array<[number, number | null, number, number]>>} */
module.exports = {
${entries}
};
`;
}

function generateLedPlacementsTypeScript(boardName: GeneratedBoardName, placements: LedPlacement[]): string {
  const grouped: Record<string, Record<number, number>> = {};

  for (const placement of placements) {
    const key = `${placement.layoutId}-${placement.sizeId}`;
    grouped[key] ??= {};
    grouped[key][placement.placementId] = placement.position;
  }

  const entries = Object.entries(grouped)
    .map(([key, ledMap]) => {
      const ledEntries = Object.entries(ledMap)
        .map(([placementId, position]) => `${placementId}: ${position}`)
        .join(', ');
      return `    '${key}': { ${ledEntries} },`;
    })
    .join('\n');

  return `  ${boardName}: {\n${entries}\n  }`;
}

function generateProductDataFile(boardData: Record<GeneratedBoardName, GeneratedBoardData>): string {
  const generatedAt = new Date().toISOString();

  return `/**
 * ⚠️ DO NOT EDIT THIS FILE MANUALLY ⚠️
 *
 * This file is auto-generated by running:
 *   bun run --filter=@boardsesh/board-constants generate
 *
 * Shared board configuration data for Aurora boards.
 * MoonBoard-specific data stays in handwritten helpers because it is not sourced
 * from the Aurora database tables used by this generator.
 *
 * Generated at: ${generatedAt}
 */

import type { BoardName } from '@boardsesh/shared-schema';
import type { LayoutData, ProductSizeData, SetData } from '../types';

// Hole placements are sharded per board and loaded lazily so Hermes only ever
// evaluates the active board's holds. The all-boards \`HOLE_PLACEMENTS\` record is
// re-exported here for backwards compatibility (Node-side consumers that iterate
// every board), but it is a lazy proxy — touching a board key requires only that
// board's shard.
export { HOLE_PLACEMENTS } from '../hole-placements';

export const AURORA_PRODUCT_SIZES: Record<BoardName, Record<number, ProductSizeData>> = {
${generateSizesTypeScript('kilter', boardData.kilter.sizes)},
${generateSizesTypeScript('tension', boardData.tension.sizes)},
${generateSizesTypeScript('decoy', boardData.decoy.sizes)},
${generateSizesTypeScript('touchstone', boardData.touchstone.sizes)},
${generateSizesTypeScript('grasshopper', boardData.grasshopper.sizes)},
${generateSizesTypeScript('soill', boardData.soill.sizes)},
  moonboard: {},
};

export const LAYOUTS: Record<BoardName, Record<number, LayoutData>> = {
${generateLayoutsTypeScript('kilter', boardData.kilter.layouts)},
${generateLayoutsTypeScript('tension', boardData.tension.layouts)},
${generateLayoutsTypeScript('decoy', boardData.decoy.layouts)},
${generateLayoutsTypeScript('touchstone', boardData.touchstone.layouts)},
${generateLayoutsTypeScript('grasshopper', boardData.grasshopper.layouts)},
${generateLayoutsTypeScript('soill', boardData.soill.layouts)},
  moonboard: {},
};

export const SETS: Record<BoardName, Record<string, SetData[]>> = {
${generateSetsTypeScript('kilter', boardData.kilter.sets)},
${generateSetsTypeScript('tension', boardData.tension.sets)},
${generateSetsTypeScript('decoy', boardData.decoy.sets)},
${generateSetsTypeScript('touchstone', boardData.touchstone.sets)},
${generateSetsTypeScript('grasshopper', boardData.grasshopper.sets)},
${generateSetsTypeScript('soill', boardData.soill.sets)},
  moonboard: {},
};

export const IMAGE_FILENAMES: Record<BoardName, Record<string, string>> = {
${generateImageFilenamesTypeScript('kilter', boardData.kilter.imageFilenames)},
${generateImageFilenamesTypeScript('tension', boardData.tension.imageFilenames)},
${generateImageFilenamesTypeScript('decoy', boardData.decoy.imageFilenames)},
${generateImageFilenamesTypeScript('touchstone', boardData.touchstone.imageFilenames)},
${generateImageFilenamesTypeScript('grasshopper', boardData.grasshopper.imageFilenames)},
${generateImageFilenamesTypeScript('soill', boardData.soill.imageFilenames)},
  moonboard: {},
};
`;
}

/**
 * The lazy hole-placement loader module. Maps each Aurora board to a literal
 * \`require()\` of its \`.cjs\` shard so Metro/webpack statically resolve the path
 * and only evaluate the shard on first call. \`HOLE_PLACEMENTS\` is a Proxy so that
 * \`Object.entries(HOLE_PLACEMENTS)\` (Node-side consumers) still enumerates every
 * board, loading each shard lazily on first property access.
 */
function generateHolePlacementsLoaderFile(): string {
  const loaderEntries = BOARD_NAMES.map(
    (boardName) =>
      `  ${boardName}: () =>\n` +
      `    hasGlobalRequire\n` +
      `      ? (require('./generated/hole-placements/${boardName}.cjs') as BoardHolePlacements)\n` +
      `      : (nodeRequire()('./generated/hole-placements/${boardName}.cjs') as BoardHolePlacements),`,
  ).join('\n');

  return `/// <reference types="node" />
/**
 * ⚠️ DO NOT EDIT THIS FILE MANUALLY ⚠️
 *
 * This file is auto-generated by running:
 *   bun run --filter=@boardsesh/board-constants generate
 *
 * Lazy per-board hole-placement loader. Each board's holds live in their own
 * \`.cjs\` shard under \`generated/hole-placements/\`; the loader requires only the
 * board that is asked for, so Hermes (Android, no JIT) never has to evaluate every
 * board's holds at once. See \`generate-board-constants.ts\` for why the shards are
 * \`.cjs\` rather than \`.ts\`.
 *
 * The \`/// <reference types="node" />\` above types the global \`require\` and
 * \`process\` this loader uses, in every consuming package — board-constants itself
 * sets no \`types\` field, and shared packages that import it (play-view,
 * climb-filters, …) compile without Node's lib. It is a type-only directive, so
 * it changes nothing at runtime in Metro/webpack.
 *
 * This file is structural (no board data), so it carries no generation timestamp
 * — regenerating with unchanged board data produces a byte-identical file and no
 * spurious diff.
 */

import type { BoardName } from '@boardsesh/shared-schema';
import type { HoldTuple } from './types';

type BoardHolePlacements = Record<string, HoldTuple[]>;

// Frozen so the shared singleton returned for boards without a shard (moonboard,
// unknown names) can't be mutated by one caller and corrupt every other.
const EMPTY_BOARD: BoardHolePlacements = Object.freeze({});

// Metro (mobile), webpack (web), and the vitest test runtime inject a global,
// synchronous \`require\`; the literal \`require('./generated/hole-placements/…cjs')\`
// calls below let those bundlers statically resolve each shard and lazily
// evaluate only the requested board.
//
// Bare Node ESM (the tsx-run generator scripts, the backend, aurora-sync, the db
// test runner) has no global \`require\`. There we build one with \`createRequire\`,
// reached through \`process.getBuiltinModule\` so this module never statically
// imports a Node builtin (which Metro could not resolve) and never touches
// \`import.meta\` (which Metro's CommonJS transform does not support). That Node
// \`createRequire\` is anchored to this module's URL, so the same relative shard
// paths resolve in both branches.
const hasGlobalRequire = typeof require === 'function';

let cachedNodeRequire: ((path: string) => unknown) | null = null;
function nodeRequire(): (path: string) => unknown {
  if (cachedNodeRequire) return cachedNodeRequire;
  const getBuiltinModule = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    // process.getBuiltinModule landed in Node 22.3. The repo pins
    // \`engines.node: 22.x\`, so this only fires if board-constants is consumed by
    // a bare Node ESM runtime older than that — surface it clearly rather than
    // failing on an undefined call.
    throw new Error(
      'No global require, and process.getBuiltinModule is unavailable. ' +
        'Loading hole-placement shards from bare Node ESM needs Node 22.3+ (the repo pins engines.node 22.x).',
    );
  }
  const moduleBuiltin = getBuiltinModule('node:module') as {
    createRequire: (path: string | URL) => (path: string) => unknown;
  };
  // Anchor createRequire to *this* module's URL so the relative shard paths
  // resolve next to the loader, regardless of the caller's cwd or how the
  // workspace is linked. \`import.meta.url\` is only read here, in the Node-only
  // branch — Metro/webpack/vitest take the global-\`require\` branch above and
  // never evaluate this function.
  cachedNodeRequire = moduleBuiltin.createRequire(import.meta.url);
  return cachedNodeRequire;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const HOLE_PLACEMENT_SHARD_LOADERS: Record<string, () => BoardHolePlacements> = {
${loaderEntries}
};
/* eslint-enable @typescript-eslint/no-require-imports */

const shardCache = new Map<string, BoardHolePlacements>();

/**
 * Return the hole placements for a single board, loading (and caching) just that
 * board's shard. Boards without a shard (e.g. \`moonboard\`, whose holds come from
 * handwritten helpers, not the Aurora generator) resolve to an empty record.
 */
export function getBoardHolePlacements(boardName: BoardName): BoardHolePlacements {
  const cached = shardCache.get(boardName);
  if (cached) return cached;

  const loader = HOLE_PLACEMENT_SHARD_LOADERS[boardName];
  const placements = loader ? loader() : EMPTY_BOARD;
  shardCache.set(boardName, placements);
  return placements;
}

// All board names that have (or could have) hole placements, including the
// non-Aurora \`moonboard\` so the proxy enumerates the same keys the old eager
// record did.
const ALL_BOARD_NAMES: BoardName[] = [
  ...([${BOARD_NAMES.map((boardName) => `'${boardName}'`).join(', ')}] as const),
  'moonboard',
];

/**
 * Backwards-compatible all-boards view. A Proxy keeps the old
 * \`HOLE_PLACEMENTS[board][key]\` and \`Object.entries(HOLE_PLACEMENTS)\` shapes
 * working for Node-side consumers (backend export, aurora-sync, the iOS Swift
 * generator) while still loading each board's shard lazily on first access — the
 * mobile hot path (\`getBoardHolePlacements\`) never forces the other boards.
 */
export const HOLE_PLACEMENTS: Record<BoardName, BoardHolePlacements> = new Proxy(
  {} as Record<BoardName, BoardHolePlacements>,
  {
    get(_target, property: string | symbol) {
      if (typeof property !== 'string' || !ALL_BOARD_NAMES.includes(property as BoardName)) {
        return undefined;
      }
      return getBoardHolePlacements(property as BoardName);
    },
    ownKeys() {
      return ALL_BOARD_NAMES;
    },
    has(_target, property: string | symbol) {
      return typeof property === 'string' && ALL_BOARD_NAMES.includes(property as BoardName);
    },
    getOwnPropertyDescriptor(_target, property: string | symbol) {
      // Guard like the get/has traps so an unknown key reports \`undefined\` rather
      // than a phantom descriptor — otherwise the three traps disagree and
      // descriptor-walking consumers (structuredClone, serializers) misbehave.
      if (typeof property !== 'string' || !ALL_BOARD_NAMES.includes(property as BoardName)) {
        return undefined;
      }
      // The target has no such own property and is extensible, so the descriptor
      // must be \`configurable: true\` to satisfy the Proxy invariant. Expose the
      // board's placements as the value so descriptor-walkers see real data.
      return {
        enumerable: true,
        configurable: true,
        writable: false,
        value: getBoardHolePlacements(property as BoardName),
      };
    },
  },
);
`;
}

function generateLedDataFile(boardData: Record<GeneratedBoardName, GeneratedBoardData>): string {
  const generatedAt = new Date().toISOString();

  return `/**
 * ⚠️ DO NOT EDIT THIS FILE MANUALLY ⚠️
 *
 * This file is auto-generated by running:
 *   bun run --filter=@boardsesh/board-constants generate
 *
 * LED placement data for Aurora boards.
 * Kept in a separate module so consumers can lazy-load it without pulling in the
 * larger product/layout/set constants.
 *
 * Generated at: ${generatedAt}
 */

import type { BoardName } from '@boardsesh/shared-schema';

export const LED_PLACEMENTS: Record<BoardName, Record<string, Record<number, number>>> = {
${generateLedPlacementsTypeScript('kilter', boardData.kilter.ledPlacements)},
${generateLedPlacementsTypeScript('tension', boardData.tension.ledPlacements)},
${generateLedPlacementsTypeScript('decoy', boardData.decoy.ledPlacements)},
${generateLedPlacementsTypeScript('touchstone', boardData.touchstone.ledPlacements)},
${generateLedPlacementsTypeScript('grasshopper', boardData.grasshopper.ledPlacements)},
${generateLedPlacementsTypeScript('soill', boardData.soill.ledPlacements)},
  moonboard: {},
};
`;
}

function main(): void {
  const boardData = {} as Record<GeneratedBoardName, GeneratedBoardData>;

  for (const boardName of BOARD_NAMES) {
    console.info(`Querying ${boardName} board constants...`);
    boardData[boardName] = {
      sizes: querySizes(boardName),
      layouts: queryLayouts(boardName),
      sets: querySets(boardName),
      imageFilenames: queryImageFilenames(boardName),
      ledPlacements: queryLedPlacements(boardName),
      holePlacements: queryHolePlacements(boardName),
    };
    assertBoardDataIsComplete(boardName, boardData[boardName]);
  }

  console.info(`Writing ${PRODUCT_OUTPUT_PATH}...`);
  writeFileSync(PRODUCT_OUTPUT_PATH, generateProductDataFile(boardData), 'utf-8');

  console.info(`Writing per-board hole-placement shards to ${HOLE_PLACEMENTS_SHARD_DIR}...`);
  mkdirSync(HOLE_PLACEMENTS_SHARD_DIR, { recursive: true });
  for (const boardName of BOARD_NAMES) {
    const shardPath = join(HOLE_PLACEMENTS_SHARD_DIR, `${boardName}.cjs`);
    writeFileSync(shardPath, generateHolePlacementsShard(boardName, boardData[boardName].holePlacements), 'utf-8');
  }

  console.info(`Writing ${HOLE_PLACEMENTS_LOADER_PATH}...`);
  writeFileSync(HOLE_PLACEMENTS_LOADER_PATH, generateHolePlacementsLoaderFile(), 'utf-8');

  console.info(`Writing ${LED_OUTPUT_PATH}...`);
  writeFileSync(LED_OUTPUT_PATH, generateLedDataFile(boardData), 'utf-8');

  console.info('Board constants generated.');
}

// Only query the database and rewrite files when this script is the entry point.
// The emit helpers above are re-used by `reshard-hole-placements.ts`, which
// re-emits the shards from the already-committed data when only the file layout
// changes (no DB available / no data change), so importing this module must not
// trigger a database query.
const invokedDirectly = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedDirectly) {
  main();
}

export {
  BOARD_NAMES,
  generateHolePlacementsShard,
  generateHolePlacementsLoaderFile,
  HOLE_PLACEMENTS_SHARD_DIR,
  HOLE_PLACEMENTS_LOADER_PATH,
  type HolePlacement,
  type GeneratedBoardName,
};
