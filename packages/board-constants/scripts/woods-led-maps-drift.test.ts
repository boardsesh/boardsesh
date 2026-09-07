import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { loadWoodsLedTables, renderWoodsBoardDataSwift, renderWoodsLedMapsTs } from './woods-led-maps-sources';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const docsDir = join(repoRoot, 'docs', 'woods-board-led-maps');

// Both committed artifacts must be byte-identical to what the generator
// renders from the docs JSON — a stale regenerate would desync the JS and
// Swift encoders' LED maps (wrong holds lit from the Live Activity while the
// in-app path lights the right ones). Fix a failure by re-running:
//   node --import tsx packages/board-constants/scripts/generate-woods-led-maps.ts
describe('woods LED map artifacts', () => {
  const tables = loadWoodsLedTables(docsDir);

  it('src/generated/woods-led-maps-data.ts matches the docs JSON source', () => {
    const committed = readFileSync(join(here, '..', 'src', 'generated', 'woods-led-maps-data.ts'), 'utf8');
    expect(committed).toBe(renderWoodsLedMapsTs(tables));
  });

  it('modules/live-activity/ios/WoodsBoardData.swift matches the docs JSON source', () => {
    const committed = readFileSync(
      join(repoRoot, 'packages', 'mobile', 'modules', 'live-activity', 'ios', 'WoodsBoardData.swift'),
      'utf8',
    );
    expect(committed).toBe(renderWoodsBoardDataSwift(tables));
  });

  it('renders the spec §7 table shapes (8x10: 485 entries to LED ≤484; 12x12: 894 to ≤897)', () => {
    expect(Object.keys(tables['8x10'])).toHaveLength(485);
    expect(Object.keys(tables['12x12'])).toHaveLength(894);
    expect(Math.max(...Object.values(tables['8x10']))).toBe(484);
    expect(Math.max(...Object.values(tables['12x12']))).toBe(897);
  });
});
