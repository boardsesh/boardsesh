import { describe, expect, it } from 'vitest';
import type { ParsedBoardConfigPath } from '@boardsesh/play-view/readable-url-utils';
import {
  buildBoardClimbTarget,
  buildBoardListTarget,
  buildSlugClimbTarget,
  buildSlugListTarget,
  toBoardPath,
} from '../board-route-target';

const CLIMB_UUID = '0A1B2C3D4E5F60718293A4B5C6D7E8F9';

// The canonical Kilter board every shared link in the docs uses:
// /kilter/original/12x12-square/screw_bolt/40 === /kilter/1/10/1,20/40
const NAMED_PARAMS = {
  boardName: 'kilter',
  layoutId: 'original',
  sizeId: '12x12-square',
  setIds: 'screw_bolt',
  angle: '40',
};
const NUMERIC_PARAMS = {
  boardName: 'kilter',
  layoutId: '1',
  sizeId: '10',
  setIds: '1,20',
  angle: '40',
};
const KILTER_BOARD = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
} satisfies ParsedBoardConfigPath;

describe('buildBoardListTarget', () => {
  it('resolves the named slugs the web app emits', () => {
    expect(buildBoardListTarget(NAMED_PARAMS)).toEqual({ kind: 'list', board: KILTER_BOARD });
  });

  it('accepts the legacy fully-numeric form', () => {
    expect(buildBoardListTarget(NUMERIC_PARAMS)).toEqual({ kind: 'list', board: KILTER_BOARD });
  });

  it('keeps every set id when the URL selects several', () => {
    expect(buildBoardListTarget({ ...NUMERIC_PARAMS, setIds: '1,20' })?.kind).toBe('list');
    const target = buildBoardListTarget({ ...NUMERIC_PARAMS, setIds: '1,20' });
    expect(target && target.kind === 'list' && target.board.setIds).toBe('1,20');
  });

  it('is not found when a segment is missing', () => {
    expect(buildBoardListTarget({ ...NAMED_PARAMS, sizeId: undefined })).toBeNull();
  });

  it('is not found for a layout slug no board has', () => {
    expect(buildBoardListTarget({ ...NAMED_PARAMS, layoutId: 'not-a-layout' })).toBeNull();
  });

  it('is not found for an unsupported board name', () => {
    expect(buildBoardListTarget({ ...NUMERIC_PARAMS, boardName: 'notaboard' })).toBeNull();
  });

  it('is not found for a non-numeric angle', () => {
    expect(buildBoardListTarget({ ...NAMED_PARAMS, angle: 'forty' })).toBeNull();
  });
});

describe('buildBoardClimbTarget', () => {
  it('pulls the uuid out of a name-slugged climb segment', () => {
    expect(buildBoardClimbTarget(NAMED_PARAMS, 'view', `crimpy-thing-${CLIMB_UUID}`)).toEqual({
      kind: 'climb',
      board: KILTER_BOARD,
      climbUuid: CLIMB_UUID,
    });
  });

  it('treats /play as the same destination as /view', () => {
    expect(buildBoardClimbTarget(NAMED_PARAMS, 'play', CLIMB_UUID)).toEqual(
      buildBoardClimbTarget(NAMED_PARAMS, 'view', CLIMB_UUID),
    );
  });

  it('carries no surface into the target — both open the play drawer', () => {
    const target = buildBoardClimbTarget(NAMED_PARAMS, 'play', CLIMB_UUID);
    expect(target && Object.keys(target.kind === 'climb' ? target.board : {})).toEqual([
      'boardName',
      'layoutId',
      'sizeId',
      'setIds',
      'angle',
    ]);
  });

  it('is not found without a climb segment', () => {
    expect(buildBoardClimbTarget(NAMED_PARAMS, 'view', undefined)).toBeNull();
  });

  // Expo Router hands params over already decoded, so a segment carrying a `/`
  // must be re-encoded on the way into the parser or it reads as extra route
  // structure and the whole URL stops matching.
  it('does not let a slash inside a param break the parse', () => {
    expect(buildBoardClimbTarget({ ...NAMED_PARAMS, layoutId: 'original/list' }, 'view', CLIMB_UUID)).toBeNull();
  });
});

describe('buildSlugListTarget', () => {
  it('leaves the angle null when the URL carries none', () => {
    expect(buildSlugListTarget('crux-club-kilter')).toEqual({
      kind: 'slug-list',
      slug: 'crux-club-kilter',
      angle: null,
    });
  });

  it('parses the angle segment', () => {
    expect(buildSlugListTarget('crux-club-kilter', '40')).toEqual({
      kind: 'slug-list',
      slug: 'crux-club-kilter',
      angle: 40,
    });
  });

  it('is not found for a malformed angle rather than falling back to the board angle', () => {
    expect(buildSlugListTarget('crux-club-kilter', 'forty')).toBeNull();
  });

  // All digits, so the regex passes — but `Number()` gives 1e+22, which
  // `toBoardPath` serialises in exponential form and `parseNamedBoardPath` then
  // rejects, quietly substituting the board's stored angle. That silent fallback
  // is the thing this parser exists to prevent, so the target has to fail here.
  it.each(['9999999999999999999999', '-9999999999999999999999', '9007199254740993'])(
    'is not found for an angle too large to survive the round trip (%s)',
    (angle) => {
      expect(buildSlugListTarget('crux-club-kilter', angle)).toBeNull();
    },
  );

  it('is not found without a slug', () => {
    expect(buildSlugListTarget(undefined)).toBeNull();
  });
});

describe('buildSlugClimbTarget', () => {
  it('resolves slug, angle and climb uuid', () => {
    expect(buildSlugClimbTarget('crux-club-kilter', '40', `crimpy-thing-${CLIMB_UUID}`)).toEqual({
      kind: 'slug-climb',
      slug: 'crux-club-kilter',
      angle: 40,
      climbUuid: CLIMB_UUID,
    });
  });

  it('is not found without a climb segment', () => {
    expect(buildSlugClimbTarget('crux-club-kilter', '40', undefined)).toBeNull();
  });
});

describe('toBoardPath', () => {
  it('builds the tuple path resolveBoardForSession understands', () => {
    expect(toBoardPath({ kind: 'list', board: KILTER_BOARD })).toBe('kilter/1/10/1,20/40');
  });

  it('builds a named-board path with and without an angle', () => {
    expect(toBoardPath({ kind: 'slug-list', slug: 'crux-club-kilter', angle: null })).toBe('/b/crux-club-kilter');
    expect(toBoardPath({ kind: 'slug-climb', slug: 'crux-club-kilter', angle: 40, climbUuid: CLIMB_UUID })).toBe(
      '/b/crux-club-kilter/40',
    );
  });
});
