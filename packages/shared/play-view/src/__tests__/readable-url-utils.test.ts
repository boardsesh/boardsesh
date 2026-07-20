import { describe, expect, it } from 'vitest';
import { getAllLayouts, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE } from '@boardsesh/board-config';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import {
  buildReadableClimbListPath,
  buildReadableClimbViewPath,
  extractUuidFromClimbSegment,
  parseBoardListPath,
  parseBoardRoutePath,
  parseClimbRoutePath,
  resolveBoardSegmentsToIds,
  resolveSizeSlug,
  tryBuildReadableClimbListPath,
  tryBuildReadableClimbViewPath,
} from '../readable-url-utils';

const CLIMB_UUID = '0A1B2C3D4E5F60718293A4B5C6D7E8F9';

describe('extractUuidFromClimbSegment', () => {
  it('pulls the uuid out of a name-slugged segment', () => {
    expect(extractUuidFromClimbSegment(`crimpy-thing-${CLIMB_UUID}`)).toBe(CLIMB_UUID);
  });

  it('passes a bare uuid through', () => {
    expect(extractUuidFromClimbSegment(CLIMB_UUID)).toBe(CLIMB_UUID);
  });

  it('decodes a percent-encoded segment before matching', () => {
    expect(extractUuidFromClimbSegment(`a%20b-${CLIMB_UUID}`)).toBe(CLIMB_UUID);
  });

  it('returns the segment unchanged when there is no uuid in it', () => {
    expect(extractUuidFromClimbSegment('not-a-climb')).toBe('not-a-climb');
  });
});

describe('parseClimbRoutePath', () => {
  it('parses the canonical named form', () => {
    expect(parseClimbRoutePath(`/kilter/original/12x12-square/screw_bolt/40/view/crimpy-${CLIMB_UUID}`)).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 40,
      climbUuid: CLIMB_UUID,
      surface: 'view',
    });
  });

  it('parses the legacy fully-numeric form', () => {
    expect(parseClimbRoutePath(`/kilter/1/10/1,20/40/view/${CLIMB_UUID}`)).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 40,
      climbUuid: CLIMB_UUID,
      surface: 'view',
    });
  });

  it('treats /play as the same destination as /view', () => {
    const parsed = parseClimbRoutePath(`/kilter/1/10/1,20/40/play/${CLIMB_UUID}`);
    expect(parsed?.surface).toBe('play');
    expect(parsed?.climbUuid).toBe(CLIMB_UUID);
  });

  it('strips a locale prefix, an origin, and a query string', () => {
    expect(
      parseClimbRoutePath(`https://www.boardsesh.com/es/kilter/1/10/1,20/40/view/${CLIMB_UUID}?from=feed`),
    ).toEqual(expect.objectContaining({ boardName: 'kilter', angle: 40, climbUuid: CLIMB_UUID }));
  });

  it('accepts a negative angle', () => {
    expect(parseClimbRoutePath(`/kilter/1/10/1,20/-5/view/${CLIMB_UUID}`)?.angle).toBe(-5);
  });

  it('rejects paths that are not climb routes', () => {
    expect(parseClimbRoutePath('/kilter/original/12x12-square/screw_bolt/40/list')).toBeNull();
    expect(parseClimbRoutePath('/b/boiler-room-moonboard-c937dad5/40/view/abc')).toBeNull();
    expect(parseClimbRoutePath('/join/abc')).toBeNull();
    expect(parseClimbRoutePath('')).toBeNull();
  });

  it('rejects an unknown board name', () => {
    expect(parseClimbRoutePath(`/notaboard/1/10/1,20/40/view/${CLIMB_UUID}`)).toBeNull();
  });

  it('rejects a non-numeric angle', () => {
    expect(parseClimbRoutePath(`/kilter/1/10/1,20/steep/view/${CLIMB_UUID}`)).toBeNull();
  });

  it('rejects a mixed numeric/named path whose slugs do not resolve', () => {
    expect(parseClimbRoutePath(`/kilter/original/10/1,20/40/view/${CLIMB_UUID}`)).toBeNull();
  });
});

describe('parseBoardListPath', () => {
  it('parses both forms', () => {
    expect(parseBoardListPath('/kilter/original/12x12-square/screw_bolt/40/list')).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      angle: 40,
    });
    expect(parseBoardListPath('/kilter/1/10/1,20/40/list')?.layoutId).toBe(1);
  });

  it('rejects a board path with no surface segment', () => {
    expect(parseBoardListPath('/kilter/1/10/1,20/40')).toBeNull();
  });
});

describe('parseBoardRoutePath', () => {
  it('returns trailing segments so callers can dispatch on the surface', () => {
    expect(parseBoardRoutePath('/kilter/1/10/1,20/40/playlists/abc')?.rest).toEqual(['playlists', 'abc']);
  });
});

describe('round-trip across every real board config', () => {
  const auroraBoards = SUPPORTED_BOARDS.filter((boardName) => boardName !== 'moonboard');

  /**
   * Exact round-trip: every real board config produces a URL that parses back to
   * that same config. This is only achievable because `resolveSizeSlug`
   * disambiguates sizes that share a base slug — before it, Kilter size 27
   * ("12 x 12 without kickboard") had no addressable URL at all.
   */
  it.each(auroraBoards)('%s: every layout/size/set-combination URL round-trips exactly', (boardName) => {
    let checked = 0;

    for (const layout of getAllLayouts(boardName)) {
      for (const size of getSizesForLayoutId(boardName, layout.id)) {
        const sets = getSetsForLayoutAndSize(boardName, layout.id, size.id);
        if (sets.length === 0) continue;

        const setIds = sets.map((set) => set.id).join(',');
        const config = { boardName, layoutId: layout.id, sizeId: size.id, setIds, angle: 40 };
        const label = `${boardName} ${layout.name} / ${size.name}`;

        const viewPath = buildReadableClimbViewPath({ ...config, climbUuid: CLIMB_UUID, climbName: 'Crimpy Thing' });
        expect(parseClimbRoutePath(viewPath), `${label} → ${viewPath}`).toEqual({
          ...config,
          climbUuid: CLIMB_UUID,
          surface: 'view',
        });

        const listPath = buildReadableClimbListPath(config);
        expect(parseBoardListPath(listPath), `${label} → ${listPath}`).toEqual(config);

        checked += 1;
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('gives every size on a layout a distinct slug', () => {
    for (const boardName of auroraBoards) {
      for (const layout of getAllLayouts(boardName)) {
        const slugs = getSizesForLayoutId(boardName, layout.id).map((size) =>
          resolveSizeSlug(boardName, layout.id, size.id),
        );
        expect(new Set(slugs).size, `${boardName} layout ${layout.id} (${layout.name}) has colliding size slugs`).toBe(
          slugs.length,
        );
      }
    }
  });
});

describe('the previously-lossy size slug', () => {
  // Kilter layout 1 sizes 10 ("12 x 12 with kickboard") and 27 ("12 x 12
  // without kickboard") both base-slug to `12x12-square`.
  it('keeps the bare slug pointing at the size every existing link already meant', () => {
    expect(resolveSizeSlug('kilter', 1, 10)).toBe('12x12-square');
    expect(parseBoardListPath('/kilter/original/12x12-square/screw_bolt/40/list')?.sizeId).toBe(10);
  });

  it('gives the shadowed size a qualified slug that now resolves', () => {
    expect(resolveSizeSlug('kilter', 1, 27)).toBe('12x12-square-without-kickboard');
    expect(parseBoardListPath('/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list')?.sizeId).toBe(27);
  });

  it('builds the qualified slug into new share URLs for the shadowed size', () => {
    const setIds = getSetsForLayoutAndSize('kilter', 1, 27)
      .map((set) => set.id)
      .join(',');
    expect(
      buildReadableClimbViewPath({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 27,
        setIds,
        angle: 40,
        climbUuid: CLIMB_UUID,
      }),
    ).toContain('/12x12-square-without-kickboard/');
  });

  it('returns null for a size that is not on the layout', () => {
    expect(resolveSizeSlug('kilter', 1, 99999)).toBeNull();
  });

  it('gives web the qualified slug too, so a link means the same board on both hosts', () => {
    const setIds = getSetsForLayoutAndSize('kilter', 1, 27)
      .map((set) => set.id)
      .join(',');
    // The id-aware builder web's tryConstructSlugViewUrl now delegates to.
    expect(
      tryBuildReadableClimbViewPath({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 27,
        setIds,
        angle: 40,
        climbUuid: CLIMB_UUID,
      }),
    ).toContain('/12x12-square-without-kickboard/');
  });

  it('reports unresolvable configs as null instead of falling back to numeric segments', () => {
    const unresolvable = {
      boardName: 'kilter',
      layoutId: 99999,
      sizeId: 99999,
      setIds: '99999',
      angle: 40,
    };
    expect(tryBuildReadableClimbListPath(unresolvable)).toBeNull();
    expect(tryBuildReadableClimbViewPath({ ...unresolvable, climbUuid: CLIMB_UUID })).toBeNull();
    // The non-try builder still falls back, which is what share links rely on.
    expect(buildReadableClimbListPath(unresolvable)).toBe('/kilter/99999/99999/99999/40/list');
  });

  it('moonboard: every layout/set-combination URL parses back to its ids', () => {
    for (const [layoutKey, layout] of Object.entries(MOONBOARD_LAYOUTS)) {
      const sets = MOONBOARD_SETS[layoutKey as keyof typeof MOONBOARD_SETS];
      const setIds = sets.map((set) => set.id).join(',');

      const viewPath = buildReadableClimbViewPath({
        boardName: 'moonboard',
        layoutId: layout.id,
        sizeId: MOONBOARD_SIZE.id,
        setIds,
        angle: 40,
        climbUuid: CLIMB_UUID,
      });

      expect(parseClimbRoutePath(viewPath), `${layout.name} → ${viewPath}`).toEqual({
        boardName: 'moonboard',
        layoutId: layout.id,
        sizeId: MOONBOARD_SIZE.id,
        setIds,
        angle: 40,
        climbUuid: CLIMB_UUID,
        surface: 'view',
      });
    }
  });
});

describe('resolveBoardSegmentsToIds', () => {
  it('resolves a subset of sets', () => {
    const allSets = getSetsForLayoutAndSize('kilter', 1, 10);
    expect(allSets.length).toBeGreaterThan(1);

    const single = resolveBoardSegmentsToIds({
      boardName: 'kilter',
      layoutSlug: 'original',
      sizeSlug: '12x12-square',
      setSlug: 'bolt',
    });
    expect(single?.setIds.split(',')).toHaveLength(1);
  });

  it('rejects a set slug that only partially matches', () => {
    expect(
      resolveBoardSegmentsToIds({
        boardName: 'kilter',
        layoutSlug: 'original',
        sizeSlug: '12x12-square',
        setSlug: 'bolt_nonsense',
      }),
    ).toBeNull();
  });

  it('rejects unknown slugs', () => {
    expect(
      resolveBoardSegmentsToIds({
        boardName: 'kilter',
        layoutSlug: 'nope',
        sizeSlug: '12x12-square',
        setSlug: 'screw_bolt',
      }),
    ).toBeNull();
    expect(
      resolveBoardSegmentsToIds({
        boardName: 'notaboard',
        layoutSlug: 'original',
        sizeSlug: '12x12-square',
        setSlug: 'screw_bolt',
      }),
    ).toBeNull();
  });
});
