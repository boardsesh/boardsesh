// The Near you list's title and empty line when narrowed to one board type,
// read against the shipped en-US catalog.
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import { nearbyEmptyLine, nearbyListTitle } from '../nearby-board-type-copy';

function lookup(key: string, params?: Record<string, string>): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      boardsCatalog,
    );
  if (typeof value !== 'string') throw new Error(`no catalog entry for ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => params?.[name] ?? placeholder);
}
const t = lookup as unknown as TFunction<'boards'>;

const BRAND_NAMES: Record<(typeof AURORA_BOARDS)[number], string> = {
  kilter: 'Kilter',
  tension: 'Tension',
  decoy: 'Decoy',
  touchstone: 'Touchstone',
  grasshopper: 'Grasshopper',
  soill: 'So iLL',
};

describe('nearby board-type copy', () => {
  it('says "Near you" and "Nothing within 20 km" when not narrowed', () => {
    expect(nearbyListTitle(t, null)).toBe('Near you');
    expect(nearbyEmptyLine(t, null)).toBe('Nothing within 20 km');
  });

  it('has its own words for MoonBoards', () => {
    expect(nearbyListTitle(t, 'moonboard')).toBe('MoonBoards near you');
    expect(nearbyEmptyLine(t, 'moonboard')).toBe('No MoonBoards within 20 km');
  });

  // Every type the quickstart can hand the list: the Aurora boards. Each reads
  // as its brand, never the lowercase board id.
  it.each(AURORA_BOARDS)('names %s by its brand', (boardType) => {
    const brand = BRAND_NAMES[boardType];
    expect(nearbyListTitle(t, boardType)).toBe(`${brand} boards near you`);
    expect(nearbyEmptyLine(t, boardType)).toBe(`No ${brand} boards within 20 km`);
  });
});
