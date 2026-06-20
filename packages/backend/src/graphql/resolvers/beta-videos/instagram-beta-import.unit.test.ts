import { describe, it, expect } from 'vitest';
import {
  classifyScanPosts,
  climbNameKey,
  parseScanPosts,
  type ParsedScanPost,
  type ScanClimbRow,
} from './instagram-beta-import-classify';

// Builders keep each case readable — only the fields under test vary.
function climb(overrides: Partial<ScanClimbRow> & Pick<ScanClimbRow, 'uuid' | 'name'>): ScanClimbRow {
  return {
    boardType: 'kilter',
    layoutId: 8,
    setterUsername: null,
    isListed: true,
    isDraft: false,
    angle: 40,
    ...overrides,
  };
}

function post(overrides: Partial<ParsedScanPost> & Pick<ParsedScanPost, 'shortcode'>): ParsedScanPost {
  return {
    link: `https://www.instagram.com/p/${overrides.shortcode}/`,
    hadCaption: true,
    parsedName: 'Air Bender',
    parsedAngle: 40,
    resolvedBoardType: 'kilter',
    ...overrides,
  };
}

function mapOf(climbs: ScanClimbRow[]): Map<string, ScanClimbRow[]> {
  const byName = new Map<string, ScanClimbRow[]>();
  for (const c of climbs) {
    const key = climbNameKey(c.boardType, c.name);
    byName.set(key, [...(byName.get(key) ?? []), c]);
  }
  return byName;
}

describe('classifyScanPosts', () => {
  it('buckets a single climb match as a confident match', () => {
    const climbs = [climb({ uuid: 'climb-1', name: 'Air Bender', angle: 30 })];
    const result = classifyScanPosts(
      [post({ shortcode: 'AAA', parsedAngle: 25 })],
      mapOf(climbs),
      new Set(),
      new Map(),
    );

    expect(result.scanned).toBe(1);
    expect(result.parsed).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toEqual({
      shortcode: 'AAA',
      link: 'https://www.instagram.com/p/AAA/',
      climbUuid: 'climb-1',
      climbName: 'Air Bender',
      boardType: 'kilter',
      // Angle comes from the parsed caption, not the climb row.
      angle: 25,
    });
    expect(result.alreadyLinked).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
  });

  it('buckets a name matching two climbs as ambiguous with both candidates', () => {
    const climbs = [
      climb({ uuid: 'climb-1', name: 'Air Bender', layoutId: 8, setterUsername: 'alice' }),
      climb({ uuid: 'climb-2', name: 'Air Bender', layoutId: 9, setterUsername: 'bob' }),
    ];
    const result = classifyScanPosts([post({ shortcode: 'AAA' })], mapOf(climbs), new Set(), new Map());

    expect(result.missing).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].parsedName).toBe('Air Bender');
    expect(result.ambiguous[0].candidates).toEqual([
      { climbUuid: 'climb-1', name: 'Air Bender', layoutId: 8, setterUsername: 'alice' },
      { climbUuid: 'climb-2', name: 'Air Bender', layoutId: 9, setterUsername: 'bob' },
    ]);
  });

  it('prefers listed climbs so a delisted duplicate does not create ambiguity', () => {
    const climbs = [
      climb({ uuid: 'listed', name: 'Air Bender', isListed: true }),
      climb({ uuid: 'delisted', name: 'Air Bender', isListed: false }),
      climb({ uuid: 'draft', name: 'Air Bender', isListed: true, isDraft: true }),
    ];
    const result = classifyScanPosts([post({ shortcode: 'AAA' })], mapOf(climbs), new Set(), new Map());

    expect(result.ambiguous).toHaveLength(0);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].climbUuid).toBe('listed');
  });

  it('buckets a post whose shortcode is already attached as alreadyLinked', () => {
    const climbs = [climb({ uuid: 'climb-1', name: 'Air Bender' })];
    const existing = new Set(['AAA']);
    const result = classifyScanPosts([post({ shortcode: 'AAA' })], mapOf(climbs), existing, new Map());

    expect(result.missing).toHaveLength(0);
    expect(result.alreadyLinked).toHaveLength(1);
    expect(result.alreadyLinked[0].climbUuid).toBe('climb-1');
    expect(result.alreadyLinked[0].climbName).toBe('Air Bender');
  });

  it('reports alreadyLinked via the existing link climb when the name no longer matches', () => {
    // Shortcode already attached, but the caption name resolves to nothing now
    // (climb renamed/delisted away). Fall back to the existing link's climb.
    const existing = new Set(['AAA']);
    const climbByShortcode = new Map([['AAA', 'legacy-climb']]);
    const result = classifyScanPosts(
      [post({ shortcode: 'AAA', parsedName: 'Ghost Climb' })],
      new Map(),
      existing,
      climbByShortcode,
    );

    expect(result.alreadyLinked).toHaveLength(1);
    expect(result.alreadyLinked[0].climbUuid).toBe('legacy-climb');
    expect(result.alreadyLinked[0].climbName).toBe('Ghost Climb');
  });

  it('buckets a parsed name with no climb match as unmatched no-climb', () => {
    const result = classifyScanPosts(
      [post({ shortcode: 'AAA', parsedName: 'Nonexistent' })],
      new Map(),
      new Set(),
      new Map(),
    );

    expect(result.parsed).toBe(1);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]).toEqual({
      shortcode: 'AAA',
      link: 'https://www.instagram.com/p/AAA/',
      parsedName: 'Nonexistent',
      reason: 'no-climb',
    });
  });

  it('buckets a missing caption as no-caption and an unparseable caption as not-parsed', () => {
    const noCaption = post({ shortcode: 'NOCAP', hadCaption: false, parsedName: null });
    const unparseable = post({ shortcode: 'BADCAP', hadCaption: true, parsedName: null });
    const result = classifyScanPosts([noCaption, unparseable], new Map(), new Set(), new Map());

    // Neither counts toward `parsed`.
    expect(result.parsed).toBe(0);
    expect(result.scanned).toBe(2);
    expect(result.unmatched).toHaveLength(2);
    expect(result.unmatched.find((u) => u.shortcode === 'NOCAP')?.reason).toBe('no-caption');
    expect(result.unmatched.find((u) => u.shortcode === 'BADCAP')?.reason).toBe('not-parsed');
  });
});

describe('parseScanPosts board override', () => {
  it('resolves against the caption-detected board, overriding the input default', () => {
    // Default is kilter, but the caption names the Tension Board — resolution
    // must target tension, where the climb actually lives.
    const parsed = parseScanPosts(
      [{ shortcode: 'AAA', caption: '"Crimp Master" @ 25° on the Tension Board' }],
      'kilter',
    );
    expect(parsed[0].resolvedBoardType).toBe('tension');
    expect(parsed[0].parsedName).toBe('Crimp Master');

    const tensionClimb = climb({ uuid: 't-1', name: 'Crimp Master', boardType: 'tension' });
    const result = classifyScanPosts(parsed, mapOf([tensionClimb]), new Set(), new Map());

    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].climbUuid).toBe('t-1');
    expect(result.missing[0].boardType).toBe('tension');
  });

  it('falls back to the input default board when the caption names none', () => {
    const parsed = parseScanPosts([{ shortcode: 'AAA', caption: '"Just A Climb" @ 40°' }], 'kilter');
    expect(parsed[0].resolvedBoardType).toBe('kilter');
    expect(parsed[0].parsedName).toBe('Just A Climb');
  });
});
