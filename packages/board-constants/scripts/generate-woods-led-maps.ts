/// <reference types="node" />
/**
 * Regenerates both committed Woods Board LED-map artifacts from the lookup
 * tables that live alongside the protocol spec
 * (`docs/woods-board-led-maps/light-map-{8x10,12x12}.json`):
 *
 *   - `src/generated/woods-led-maps-data.ts` — used by the JS encoder
 *     (`@boardsesh/ble-protocol/woods`)
 *   - `packages/mobile/modules/live-activity/ios/WoodsBoardData.swift` — used
 *     by the native Swift encoder (#3314)
 *
 * Each table maps a hold's `baseHoldLocation` (the id the Woods data API uses
 * in a problem's `holdList`) to the physical LED index on that board size's
 * strip. The Woods board has no Aurora-style catalog in the database, so —
 * like the MoonBoard serpentine — this data is committed rather than queried
 * from Postgres by `generate-board-constants.ts`. A drift test pins both
 * artifacts to the JSON source: `scripts/woods-led-maps-drift.test.ts`.
 *
 * Run from the repo root:
 *   node --import tsx packages/board-constants/scripts/generate-woods-led-maps.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadWoodsLedTables, renderWoodsBoardDataSwift, renderWoodsLedMapsTs } from './woods-led-maps-sources';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const docsDir = join(repoRoot, 'docs', 'woods-board-led-maps');
const tsOutFile = join(here, '..', 'src', 'generated', 'woods-led-maps-data.ts');
const swiftOutFile = join(repoRoot, 'packages', 'mobile', 'modules', 'live-activity', 'ios', 'WoodsBoardData.swift');

const tables = loadWoodsLedTables(docsDir);
writeFileSync(tsOutFile, renderWoodsLedMapsTs(tables));
console.log(`Wrote ${tsOutFile}`);
writeFileSync(swiftOutFile, renderWoodsBoardDataSwift(tables));
console.log(`Wrote ${swiftOutFile}`);
