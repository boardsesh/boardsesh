#!/usr/bin/env bun
/**
 * Emits the C++ catalog + placement-map sources consumed by board-debug-server
 * firmware. Reads directly from the @boardsesh/board-constants generated
 * modules so the firmware never drifts from the web app's board configurator.
 *
 * Run from anywhere:
 *   bun run embedded/projects/board-debug-server/scripts/generate_debug_data.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LED_PLACEMENTS } from '../../../../packages/board-constants/src/generated/led-placements-data';
import { LAYOUTS, AURORA_PRODUCT_SIZES, SETS } from '../../../../packages/board-constants/src/generated/product-sizes-data';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'config');

type BoardKey = 'kilter' | 'tension' | 'moonboard' | 'decoy' | 'touchstone' | 'grasshopper';

const AURORA_BOARDS: BoardKey[] = ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper'];

// MoonBoard catalog mirrors moonboard-dev-server's hardcoded layouts/sets.
type SetSpec = { id: number; name: string };
const MOONBOARD_LAYOUTS: { id: number; name: string; sets: SetSpec[] }[] = [
  { id: 1, name: 'MoonBoard 2010', sets: [{ id: 1, name: 'Original School Holds' }] },
  {
    id: 2,
    name: 'MoonBoard 2016',
    sets: [
      { id: 2, name: 'Hold Set A' },
      { id: 3, name: 'Hold Set B' },
      { id: 4, name: 'Original School Holds' },
    ],
  },
  {
    id: 3,
    name: 'MoonBoard 2024',
    sets: [
      { id: 5, name: 'Hold Set D' },
      { id: 6, name: 'Hold Set E' },
      { id: 7, name: 'Hold Set F' },
      { id: 8, name: 'Wooden Holds' },
      { id: 9, name: 'Wooden Holds B' },
      { id: 10, name: 'Wooden Holds C' },
    ],
  },
  {
    id: 4,
    name: 'MoonBoard Masters 2017',
    sets: [
      { id: 11, name: 'Hold Set A' },
      { id: 12, name: 'Hold Set B' },
      { id: 13, name: 'Hold Set C' },
      { id: 14, name: 'Original School Holds' },
      { id: 15, name: 'Screw-on Feet' },
      { id: 16, name: 'Wooden Holds' },
    ],
  },
  {
    id: 5,
    name: 'MoonBoard Masters 2019',
    sets: [
      { id: 17, name: 'Hold Set A' },
      { id: 18, name: 'Hold Set B' },
      { id: 19, name: 'Original School Holds' },
      { id: 20, name: 'Screw-on Feet' },
      { id: 21, name: 'Wooden Holds' },
      { id: 22, name: 'Wooden Holds B' },
      { id: 23, name: 'Wooden Holds C' },
    ],
  },
];

const MOONBOARD_SIZE_ID = 1;

const ESCAPED_QUOTE = /"/g;
const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(ESCAPED_QUOTE, '\\"');

const symId = (board: BoardKey, ...rest: (number | string)[]) =>
  `k${board[0].toUpperCase()}${board.slice(1)}_${rest.join('_')}`;

const cppBoardEnum: Record<BoardKey, string> = {
  kilter: 'BoardName::KILTER',
  tension: 'BoardName::TENSION',
  moonboard: 'BoardName::MOONBOARD',
  decoy: 'BoardName::DECOY',
  touchstone: 'BoardName::TOUCHSTONE',
  grasshopper: 'BoardName::GRASSHOPPER',
};

type BoardEntry = {
  board: BoardKey;
  name: string;
  layouts: {
    id: number;
    name: string;
    sizes: {
      id: number;
      name: string;
      description: string;
      sets: SetSpec[];
    }[];
  }[];
};

function buildAuroraEntry(board: BoardKey): BoardEntry {
  const layoutMap = LAYOUTS[board] ?? {};
  const sizeMap = AURORA_PRODUCT_SIZES[board] ?? {};
  const setMap = SETS[board] ?? {};

  const layouts = Object.values(layoutMap)
    .sort((a, b) => a.id - b.id)
    .map((layout) => {
      const sizes = Object.values(sizeMap)
        .filter((size) => size.productId === layout.productId)
        .sort((a, b) => a.id - b.id)
        .map((size) => {
          const sets = (setMap[`${layout.id}-${size.id}`] ?? []).map((s) => ({
            id: s.id,
            name: s.name,
          }));
          return {
            id: size.id,
            name: size.name,
            description: size.description ?? '',
            sets,
          };
        })
        .filter((size) => size.sets.length > 0);
      return { id: layout.id, name: layout.name, sizes };
    })
    .filter((layout) => layout.sizes.length > 0);

  return {
    board,
    name: board,
    layouts,
  };
}

function buildMoonboardEntry(): BoardEntry {
  return {
    board: 'moonboard',
    name: 'moonboard',
    layouts: MOONBOARD_LAYOUTS.map((layout) => ({
      id: layout.id,
      name: layout.name,
      sizes: [
        {
          id: MOONBOARD_SIZE_ID,
          name: 'Standard',
          description: '11x18 Grid',
          sets: layout.sets,
        },
      ],
    })),
  };
}

function emitCatalog(entries: BoardEntry[]): string {
  const out: string[] = [];
  out.push('// AUTO-GENERATED. Run scripts/generate_debug_data.ts to regenerate.');
  out.push('#include "board_options.h"');
  out.push('');
  out.push('namespace board_debug {');
  out.push('');

  // Emit set arrays + size arrays + layout arrays per board.
  for (const entry of entries) {
    for (const layout of entry.layouts) {
      for (const size of layout.sizes) {
        const setSym = symId(entry.board, 'L', layout.id, 'S', size.id, 'sets');
        out.push(`static const SetOption ${setSym}[] = {`);
        for (const set of size.sets) {
          out.push(`    {${set.id}, "${escape(set.name)}"},`);
        }
        out.push('};');
      }
      const sizesSym = symId(entry.board, 'L', layout.id, 'sizes');
      out.push(`static const SizeOption ${sizesSym}[] = {`);
      for (const size of layout.sizes) {
        const setSym = symId(entry.board, 'L', layout.id, 'S', size.id, 'sets');
        out.push(
          `    {${size.id}, "${escape(size.name)}", "${escape(size.description)}", ${setSym}, ${size.sets.length}},`,
        );
      }
      out.push('};');
    }
    const layoutsSym = symId(entry.board, 'layouts');
    out.push(`static const LayoutOption ${layoutsSym}[] = {`);
    for (const layout of entry.layouts) {
      const sizesSym = symId(entry.board, 'L', layout.id, 'sizes');
      out.push(`    {${layout.id}, "${escape(layout.name)}", ${sizesSym}, ${layout.sizes.length}},`);
    }
    out.push('};');
    out.push('');
  }

  out.push('const BoardCatalogEntry kBoardCatalog[] = {');
  for (const entry of entries) {
    if (entry.layouts.length === 0) continue;
    const layoutsSym = symId(entry.board, 'layouts');
    out.push(`    {${cppBoardEnum[entry.board]}, "${entry.board}", ${layoutsSym}, ${entry.layouts.length}},`);
  }
  out.push('};');
  out.push('const size_t kBoardCatalogCount = sizeof(kBoardCatalog) / sizeof(kBoardCatalog[0]);');
  out.push('');
  out.push('}  // namespace board_debug');
  out.push('');
  return out.join('\n');
}

type PlacementRow = {
  board: BoardKey;
  layoutId: number;
  sizeId: number;
  pairs: { led: number; placementId: number }[];
};

function buildPlacementRows(entries: BoardEntry[]): PlacementRow[] {
  const rows: PlacementRow[] = [];
  for (const entry of entries) {
    if (entry.board === 'moonboard') continue; // MoonBoard uses text protocol, no LED reverse-map.
    const board = entry.board;
    const placementsForBoard = LED_PLACEMENTS[board] ?? {};
    for (const layout of entry.layouts) {
      for (const size of layout.sizes) {
        const key = `${layout.id}-${size.id}`;
        const map = placementsForBoard[key];
        if (!map) continue;
        const pairs: { led: number; placementId: number }[] = [];
        for (const [placementIdStr, led] of Object.entries(map)) {
          const placementId = Number(placementIdStr);
          if (!Number.isFinite(placementId) || !Number.isFinite(led)) continue;
          pairs.push({ led: Number(led), placementId });
        }
        pairs.sort((a, b) => a.led - b.led);
        rows.push({ board, layoutId: layout.id, sizeId: size.id, pairs });
      }
    }
  }
  return rows;
}

function emitPlacements(rows: PlacementRow[]): string {
  const out: string[] = [];
  out.push('// AUTO-GENERATED. Run scripts/generate_debug_data.ts to regenerate.');
  out.push('#include "placement_maps.h"');
  out.push('');
  out.push('namespace board_debug {');
  out.push('');

  for (const row of rows) {
    const sym = symId(row.board, 'L', row.layoutId, 'S', row.sizeId, 'pmap');
    out.push(`static const PlacementEntry ${sym}[] = {`);
    // 6 entries per line keeps the diff readable.
    for (let i = 0; i < row.pairs.length; i += 6) {
      const chunk = row.pairs.slice(i, i + 6);
      out.push('    ' + chunk.map((p) => `{${p.led},${p.placementId}}`).join(', ') + ',');
    }
    out.push('};');
  }
  out.push('');

  out.push('const PlacementMap kPlacementMaps[] = {');
  for (const row of rows) {
    const sym = symId(row.board, 'L', row.layoutId, 'S', row.sizeId, 'pmap');
    out.push(
      `    {${cppBoardEnum[row.board]}, ${row.layoutId}, ${row.sizeId}, ${sym}, ${row.pairs.length}},`,
    );
  }
  out.push('};');
  out.push('const size_t kPlacementMapCount = sizeof(kPlacementMaps) / sizeof(kPlacementMaps[0]);');
  out.push('');
  out.push('}  // namespace board_debug');
  out.push('');
  return out.join('\n');
}

const entries: BoardEntry[] = [
  ...AURORA_BOARDS.map(buildAuroraEntry),
  buildMoonboardEntry(),
];

mkdirSync(OUT_DIR, { recursive: true });

const catalogPath = join(OUT_DIR, 'board_options.gen.cpp');
writeFileSync(catalogPath, emitCatalog(entries));

const placementsPath = join(OUT_DIR, 'placement_maps.gen.cpp');
writeFileSync(placementsPath, emitPlacements(buildPlacementRows(entries)));

const totalLayouts = entries.reduce((sum, e) => sum + e.layouts.length, 0);
const totalSizes = entries.reduce(
  (sum, e) => sum + e.layouts.reduce((s2, l) => s2 + l.sizes.length, 0),
  0,
);
const totalPlacementPairs = buildPlacementRows(entries).reduce((s, r) => s + r.pairs.length, 0);

console.log(
  `[debug-firmware] catalog: ${entries.length} boards, ${totalLayouts} layouts, ${totalSizes} sizes`,
);
console.log(`[debug-firmware] placement pairs (Aurora only): ${totalPlacementPairs}`);
console.log(`[debug-firmware] wrote ${catalogPath}`);
console.log(`[debug-firmware] wrote ${placementsPath}`);
