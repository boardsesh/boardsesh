import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TNUT_CORNERS,
  generateLedPositions,
  generateTnutGrid,
  groupLedPair,
  keepLedPairsFromOlderApp,
  ledPairs,
  ledPartner,
  readTnutLayout,
  separateLedPair,
  setWiringSkip,
  wiringSkipCount,
  withLedPartners,
  type TnutLayout,
  type TnutWiring,
} from '../index';

function layout(ledPlacement: TnutLayout['ledPlacement'] = 'sides'): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: 2,
    columns: 2,
    firstRowOffset: false,
    columnConvention: 'all',
    corners: DEFAULT_TNUT_CORNERS,
    holes: generateTnutGrid({
      pattern: 'grid',
      rows: 2,
      columns: 2,
      firstRowOffset: false,
      corners: DEFAULT_TNUT_CORNERS,
    }),
    ledPlacement,
    photoKey: 'canonical-photo',
  };
  configured.ledPositions = generateLedPositions(configured);
  return configured;
}

describe('LED pairs behind a hold', () => {
  it('pairs the two LEDs a "sides" placement puts behind each hole, and nothing else', () => {
    const sides = layout('sides');
    expect(sides.ledPositions).toHaveLength(8);
    const pairs = ledPairs(sides);
    expect(pairs).toHaveLength(4);
    for (const [first, second] of pairs) {
      const a = sides.ledPositions!.find((led) => led.id === first)!;
      const b = sides.ledPositions!.find((led) => led.id === second)!;
      // Side by side behind the same hole.
      expect(a.hole).toEqual(b.hole);
      expect(a.y).toBeCloseTo(b.y);
    }
    expect(ledPairs(layout('center'))).toEqual([]);
  });

  it('separates a pair and groups two LEDs, and an empty list keeps every pair separated', () => {
    const sides = layout('sides');
    const [first, second] = ledPairs(sides)[0];
    expect(ledPartner(ledPairs(sides), first)).toBe(second);
    const separated = separateLedPair(sides, second);
    expect(ledPartner(ledPairs(separated), first)).toBeNull();
    expect(ledPairs(separated)).toHaveLength(3);
    // Grouping two LEDs takes each out of any pair it was in.
    const [, other] = ledPairs(sides)[1];
    const regrouped = groupLedPair(separated, first, other);
    expect(ledPartner(ledPairs(regrouped), first)).toBe(other);
    expect(ledPairs(regrouped)).toHaveLength(3);
    const none = { ...sides, ledGroups: [] };
    expect(ledPairs(none)).toEqual([]);
  });

  it('survives a save and load, dropping pairs whose LEDs are gone and rejecting malformed ones', () => {
    const sides = layout('sides');
    const [first, second] = ledPairs(sides)[0];
    const stored = JSON.parse(
      JSON.stringify({
        ...sides,
        ledGroups: [
          [first, second],
          [first, 'removed'],
        ],
      }),
    );
    expect(readTnutLayout(stored)?.ledGroups).toEqual([[first, second]]);
    expect(readTnutLayout({ ...stored, ledGroups: [[first]] })).toBeNull();
    expect(readTnutLayout({ ...stored, ledGroups: [[first, first]] })).toBeNull();
    expect(readTnutLayout({ ...stored, ledGroups: [] })?.ledGroups).toEqual([]);
    const { ledGroups: _groups, ...withoutGroups } = stored;
    expect(readTnutLayout(withoutGroups)).not.toHaveProperty('ledGroups');
  });

  it('lays the cable through both LEDs of a pair, once each', () => {
    const pairs = [['a', 'b']] as const;
    expect(withLedPartners(['a', 'c'], pairs, new Set())).toEqual(['a', 'b', 'c']);
    expect(withLedPartners(['b', 'a'], pairs, new Set())).toEqual(['b', 'a']);
    expect(withLedPartners(['a'], pairs, new Set(['b']))).toEqual(['a']);
  });
});

describe('LED pairs that outlive their LEDs', () => {
  it('still reads a layout whose stale pairs outnumber the LEDs left', () => {
    const sides = layout('sides');
    const pairs = ledPairs(sides);
    // Three stored pairs, then two of them removed: two LEDs and three entries.
    const [kept] = pairs;
    const stored = JSON.parse(
      JSON.stringify({
        ...sides,
        ledPositions: sides.ledPositions!.filter((led) => kept.includes(led.id)),
        ledGroups: pairs.slice(0, 3),
      }),
    );
    expect(readTnutLayout(stored)?.ledGroups).toEqual([kept]);
    // The raw list is still bounded on its own.
    expect(readTnutLayout({ ...stored, ledGroups: Array.from({ length: 6001 }, () => kept) })).toBeNull();
  });

  it('reads a null list as the default pairs', () => {
    const sides = layout('sides');
    const read = readTnutLayout(JSON.parse(JSON.stringify({ ...sides, ledGroups: null })));
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty('ledGroups');
    expect(ledPairs(read!)).toEqual(ledPairs(sides));
  });
});

describe('LED pairs across an older app save', () => {
  /** An app from before pairs rebuilds the layout from the keys it knows. */
  function olderAppSave(saved: TnutLayout): TnutLayout {
    const { ledGroups: _dropped, ...known } = saved;
    return readTnutLayout(JSON.parse(JSON.stringify(known)))!;
  }

  it('keeps a hand-made pair', () => {
    const sides = layout('sides');
    const [[a], [b]] = ledPairs(sides);
    const custom = groupLedPair(sides, a, b);
    const merged = keepLedPairsFromOlderApp(olderAppSave(custom), false, custom);
    expect(ledPartner(ledPairs(merged), a)).toBe(b);
    expect(merged.ledGroups).toEqual(custom.ledGroups);
  });

  it('keeps a separated default pair separated, and an empty list empty', () => {
    const sides = layout('sides');
    const [first] = ledPairs(sides)[0];
    const separated = separateLedPair(sides, first);
    const merged = keepLedPairsFromOlderApp(olderAppSave(separated), false, separated);
    expect(ledPartner(ledPairs(merged), first)).toBeNull();
    const none = { ...sides, ledGroups: [] };
    expect(keepLedPairsFromOlderApp(olderAppSave(none), false, none).ledGroups).toEqual([]);
  });

  it('drops pairs whose LEDs the older app removed, and keeps the rest', () => {
    const sides = layout('sides');
    const custom = { ...sides, ledGroups: ledPairs(sides) };
    const [gone, ...rest] = custom.ledGroups;
    const edited = olderAppSave({
      ...custom,
      ledPositions: custom.ledPositions!.filter((led) => !gone.includes(led.id)),
    });
    expect(keepLedPairsFromOlderApp(edited, false, custom).ledGroups).toEqual(rest);
  });

  it('takes the list as sent from an app that knows about pairs, and leaves layouts with no list alone', () => {
    const sides = layout('sides');
    const separated = separateLedPair(sides, ledPairs(sides)[0][0]);
    expect(keepLedPairsFromOlderApp(sides, true, separated)).toBe(sides);
    expect(keepLedPairsFromOlderApp(olderAppSave(sides), false, sides)).not.toHaveProperty('ledGroups');
    expect(keepLedPairsFromOlderApp(olderAppSave(sides), false, null)).not.toHaveProperty('ledGroups');
  });

  it('starts from the default pairs when the older app rebuilt the LEDs for another placement', () => {
    const sides = layout('sides');
    const separated = separateLedPair(sides, ledPairs(sides)[0][0]);
    const rebuilt = olderAppSave(layout('center'));
    expect(keepLedPairsFromOlderApp(rebuilt, false, separated)).not.toHaveProperty('ledGroups');
  });

  it('starts from the default pairs when the older app rebuilt the LEDs after a rows change', () => {
    const sides = layout('sides');
    const custom = groupLedPair(sides, ...(ledPairs(sides).flat().slice(1, 3) as [string, string]));
    const taller = { ...custom, rows: 3 };
    const holes = generateTnutGrid({ ...taller, pattern: 'grid' });
    const rebuilt = olderAppSave({ ...taller, holes, ledPositions: generateLedPositions({ ...taller, holes }) });
    const merged = keepLedPairsFromOlderApp(rebuilt, false, custom);
    expect(merged).not.toHaveProperty('ledGroups');
    expect(ledPairs(merged)).toHaveLength(6);
  });

  it('keeps the stored pairs when the older app changed the holes but left the LEDs', () => {
    const sides = layout('sides');
    const separated = separateLedPair(sides, ledPairs(sides)[0][0]);
    const holes = separated.holes.map((hole) => ({ x: hole.x, y: hole.y + 0.01 }));
    const merged = keepLedPairsFromOlderApp(olderAppSave({ ...separated, holes }), false, separated);
    expect(merged.ledGroups).toEqual(separated.ledGroups);
  });
});

describe('skipped LEDs on a connection', () => {
  it('reads a stored skip in either direction', () => {
    const sides = layout('center');
    const [a, b] = sides.ledPositions!.map((led) => led.id);
    const wiring: TnutWiring = {
      direction: 'custom',
      startCorner: 'tl',
      paths: [[a, b]],
      skips: [{ from: b, to: a, count: 3 }],
    };
    expect(wiringSkipCount(wiring, a, b)).toBe(3);
    expect(wiringSkipCount(wiring, b, a)).toBe(3);
    expect(wiringSkipCount(setWiringSkip(wiring, a, b, 0), a, b)).toBe(0);
    expect(wiringSkipCount(undefined, a, b)).toBe(0);
  });
});
