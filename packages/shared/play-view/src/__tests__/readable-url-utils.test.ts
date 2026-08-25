import { describe, expect, it } from 'vitest';
import { getAllLayouts, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE, type MoonBoardLayoutKey } from '@boardsesh/board-config';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import {
  buildReadableClimbListPath,
  buildReadableClimbViewPath,
  extractUuidFromClimbSegment,
  generateLayoutSlug,
  generateSetSlug,
  generateSizeSlug,
  parseBoardListPath,
  parseBoardRoutePath,
  parseClimbRoutePath,
  PERMANENT_SIZE_SLUG_ALIASES,
  resolveBoardSegmentsToIds,
  resolvePermanentSizeSlugAlias,
  resolveSizeSlug,
  resolveSizeSlugToId,
  tryBuildReadableClimbListPath,
  tryBuildReadableClimbViewPath,
} from '../readable-url-utils';

const CLIMB_UUID = '0A1B2C3D4E5F60718293A4B5C6D7E8F9';

/**
 * A climb name that slugs to a contiguous 32-character hex run all by itself.
 * Nothing stops a setter naming a climb this — and while the uuid regex was
 * unanchored, the *first* run won and the app queried this fragment instead of
 * the real uuid, so a valid shared link rendered not-found.
 */
const HEX_RUN_CLIMB_NAME_SLUG = 'beefcafe0ff1cedeadbeefcafe0ff1ce';

/**
 * A real MoonBoard uuid, copied off the dev image. MoonBoard is the one board
 * whose climbs carry the dashed 36-character RFC-4122 form; every Aurora board
 * carries the 32-character unbroken form above.
 */
const MOONBOARD_CLIMB_UUID = '9fe54099-6fdd-5adb-b82f-2d7bcb10d4ad';

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

  it('takes the uuid at the end, not a hex run in the climb name', () => {
    expect(HEX_RUN_CLIMB_NAME_SLUG).toMatch(/^[0-9a-f]{32}$/);
    expect(extractUuidFromClimbSegment(`${HEX_RUN_CLIMB_NAME_SLUG}-${CLIMB_UUID}`)).toBe(CLIMB_UUID);
  });

  it('takes the uuid at the end even when the name runs longer than a uuid', () => {
    expect(extractUuidFromClimbSegment(`${HEX_RUN_CLIMB_NAME_SLUG}deadbeef-${CLIMB_UUID}`)).toBe(CLIMB_UUID);
  });

  it('pulls a dashed MoonBoard uuid out of a name-slugged segment', () => {
    expect(extractUuidFromClimbSegment(`to-dokids-yuito-${MOONBOARD_CLIMB_UUID}`)).toBe(MOONBOARD_CLIMB_UUID);
  });

  it('passes a bare dashed MoonBoard uuid through', () => {
    expect(extractUuidFromClimbSegment(MOONBOARD_CLIMB_UUID)).toBe(MOONBOARD_CLIMB_UUID);
  });

  it('carries a dashed MoonBoard uuid through a whole route parse', () => {
    expect(
      parseClimbRoutePath(`/moonboard/2016/standard/hold-set-a/40/view/to-dokids-yuito-${MOONBOARD_CLIMB_UUID}`)
        ?.climbUuid,
    ).toBe(MOONBOARD_CLIMB_UUID);
  });

  it('does not let the dashed shape steal the tail of an Aurora uuid', () => {
    // The dashed alternative must end at the segment end and its final group is
    // preceded by a `-`; the character twelve back from the end of a 32-hex uuid
    // is always a hex digit, so it can never match here. A name slug that looks
    // like the head of a dashed uuid is the adversarial case.
    expect(extractUuidFromClimbSegment(`deadbeef-cafe-babe-face-${CLIMB_UUID}`)).toBe(CLIMB_UUID);
  });

  it('carries the hex-named climb through a whole route parse', () => {
    expect(parseClimbRoutePath(`/kilter/1/10/1,20/40/view/${HEX_RUN_CLIMB_NAME_SLUG}-${CLIMB_UUID}`)?.climbUuid).toBe(
      CLIMB_UUID,
    );
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

  it('keeps the path when the query carries an absolute URL of its own', () => {
    // The `://` in `?next=` used to be read as this path's origin, so everything
    // up to the *query's* first slash was cut and the real path thrown away.
    expect(parseClimbRoutePath(`/kilter/1/10/1,20/40/view/${CLIMB_UUID}?next=https://example.com/somewhere`)).toEqual(
      expect.objectContaining({ boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: CLIMB_UUID }),
    );
  });

  it('still strips a real origin, query and hash together', () => {
    expect(
      parseClimbRoutePath(
        `https://www.boardsesh.com/kilter/1/10/1,20/40/view/${CLIMB_UUID}?next=https://example.com/x#holds`,
      ),
    ).toEqual(expect.objectContaining({ boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: CLIMB_UUID }));
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
  // MoonBoard and Woods are code-driven boards: they have no generated
  // LAYOUTS/SETS rows, so this catalogue-walking loop finds nothing for them.
  // Their readable URLs are covered by their own round-trip cases.
  const auroraBoards = SUPPORTED_BOARDS.filter((boardName) => boardName !== 'moonboard' && boardName !== 'woods');

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

  // If an upstream rename ever turns this expectation red, the string below is
  // still live in shared links: add it to PERMANENT_SIZE_SLUG_ALIASES *before*
  // updating the expectation, or every qualified link already out there 404s.
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

describe('legacy MoonBoard URL forms', () => {
  const canonicalMoonBoardSizeSlug = generateSizeSlug(MOONBOARD_SIZE.name, MOONBOARD_SIZE.description);

  /**
   * The layout-slug acceptance set, spelled out. Web's `getMoonBoardLayoutBySlug`
   * has always taken three forms per layout — the canonical slug, the
   * `MOONBOARD_LAYOUTS` key, and that key with its hyphens dropped — and older
   * web builds minted links in all of them. Every form here that isn't the
   * canonical slug (twelve of them) kept working on www while the shared parser
   * returned null, so an old MoonBoard link 404'd in the Expo app.
   */
  const legacyLayoutForms: { layoutKey: MoonBoardLayoutKey; layoutId: number; layoutSlugs: string[] }[] = [
    { layoutKey: 'moonboard-2010', layoutId: 1, layoutSlugs: ['2010', 'moonboard-2010', 'moonboard2010'] },
    { layoutKey: 'moonboard-2016', layoutId: 2, layoutSlugs: ['2016', 'moonboard-2016', 'moonboard2016'] },
    { layoutKey: 'moonboard-2024', layoutId: 3, layoutSlugs: ['2024', 'moonboard-2024', 'moonboard2024'] },
    {
      layoutKey: 'moonboard-masters-2017',
      layoutId: 4,
      layoutSlugs: ['masters-2017', 'moonboard-masters-2017', 'moonboardmasters2017'],
    },
    {
      layoutKey: 'moonboard-masters-2019',
      layoutId: 5,
      layoutSlugs: ['masters-2019', 'moonboard-masters-2019', 'moonboardmasters2019'],
    },
    { layoutKey: 'mini-moonboard-2020', layoutId: 6, layoutSlugs: ['mini-moonboard-2020', 'minimoonboard2020'] },
    { layoutKey: 'mini-moonboard-2025', layoutId: 7, layoutSlugs: ['mini-moonboard-2025', 'minimoonboard2025'] },
  ];

  it('pins the acceptance set to the one web derives from the same config', () => {
    const derived = Object.entries(MOONBOARD_LAYOUTS).map(([layoutKey, layout]) => ({
      layoutKey,
      layoutId: layout.id,
      // Exactly what getMoonBoardLayoutBySlug compares against: the generated
      // slug, the key, and the key normalised of hyphens.
      layoutSlugs: [...new Set([generateLayoutSlug(layout.name), layoutKey, layoutKey.replace(/-/g, '')])].sort(),
    }));

    expect(legacyLayoutForms.map((form) => ({ ...form, layoutSlugs: [...form.layoutSlugs].sort() }))).toEqual(derived);
  });

  const layoutSlugCases = legacyLayoutForms.flatMap(({ layoutKey, layoutId, layoutSlugs }) =>
    layoutSlugs.map((layoutSlug) => ({ layoutKey, layoutId, layoutSlug })),
  );

  it.each(layoutSlugCases)(
    'resolves $layoutKey from the URL form "$layoutSlug"',
    ({ layoutKey, layoutId, layoutSlug }) => {
      const sets = MOONBOARD_SETS[layoutKey];
      expect(
        resolveBoardSegmentsToIds({
          boardName: 'moonboard',
          layoutSlug,
          sizeSlug: canonicalMoonBoardSizeSlug,
          setSlug: generateSetSlug(sets.map((set) => set.name)),
        }),
      ).toEqual({
        boardName: 'moonboard',
        layoutId,
        sizeId: MOONBOARD_SIZE.id,
        setIds: sets.map((set) => set.id).join(','),
      });
    },
  );

  it('parses a whole legacy climb URL, not just the segments', () => {
    const sets = MOONBOARD_SETS['moonboard-2016'];
    expect(
      parseClimbRoutePath(
        `/moonboard/moonboard-2016/${canonicalMoonBoardSizeSlug}/${generateSetSlug(sets.map((set) => set.name))}/40/view/crimpy-${CLIMB_UUID}`,
      ),
    ).toEqual({
      boardName: 'moonboard',
      layoutId: 2,
      sizeId: MOONBOARD_SIZE.id,
      setIds: sets.map((set) => set.id).join(','),
      angle: 40,
      climbUuid: CLIMB_UUID,
      surface: 'view',
    });
  });

  // MoonBoard has one size, so web resolves the size segment by ignoring it —
  // which is why links minted before today's slug form still work there.
  it.each([canonicalMoonBoardSizeSlug, 'standard', '11x18', 'standard-11x18'])(
    'accepts the size segment spelled "%s", as www always has',
    (sizeSlug) => {
      expect(
        resolveBoardSegmentsToIds({
          boardName: 'moonboard',
          layoutSlug: '2010',
          sizeSlug,
          setSlug: 'original-school-holds',
        })?.sizeId,
      ).toBe(MOONBOARD_SIZE.id);
    },
  );

  it('still rejects an unknown layout and a set slug that does not rebuild', () => {
    expect(
      resolveBoardSegmentsToIds({
        boardName: 'moonboard',
        layoutSlug: 'moonboard-2015',
        sizeSlug: canonicalMoonBoardSizeSlug,
        setSlug: 'original-school-holds',
      }),
    ).toBeNull();
    expect(
      resolveBoardSegmentsToIds({
        boardName: 'moonboard',
        layoutSlug: '2016',
        sizeSlug: canonicalMoonBoardSizeSlug,
        setSlug: 'hold-set-a_nonsense',
      }),
    ).toBeNull();
  });
});

describe('permanently pinned size slugs', () => {
  const pinnedEntries = Object.entries(PERMANENT_SIZE_SLUG_ALIASES).flatMap(([boardName, aliasesBySizeId]) =>
    Object.entries(aliasesBySizeId ?? {}).flatMap(([sizeId, aliases]) =>
      aliases.map((alias) => ({ boardName: boardName as BoardName, sizeId: Number(sizeId), alias })),
    ),
  );

  it('has exactly the forms we have shipped', () => {
    // Integer-like keys enumerate ascending, so size 7 comes first however the
    // source object is written.
    expect(pinnedEntries).toEqual([
      { boardName: 'kilter', sizeId: 7, alias: '12x14-commerical' },
      { boardName: 'kilter', sizeId: 10, alias: '12x12-square' },
      { boardName: 'kilter', sizeId: 27, alias: '12x12-square-without-kickboard' },
    ]);
  });

  it.each(pinnedEntries)(
    'resolves $boardName "$alias" to size $sizeId without consulting the size name',
    ({ boardName, sizeId, alias }) => {
      // The alias path is name-blind: it maps the string straight to an id. That
      // is what keeps a link alive when upstream renames the size and the
      // generated qualifier moves out from under it — no need to mutate the
      // board data to prove it, the lookup never reads a name in the first place.
      expect(resolvePermanentSizeSlugAlias(boardName, alias)).toBe(sizeId);
    },
  );

  it.each(pinnedEntries)(
    'resolves $boardName "$alias" on every layout that has size $sizeId',
    ({ boardName, sizeId, alias }) => {
      const layoutsWithSize = getAllLayouts(boardName).filter((layout) =>
        getSizesForLayoutId(boardName, layout.id).some((size) => size.id === sizeId),
      );
      expect(layoutsWithSize.length).toBeGreaterThan(0);

      for (const layout of layoutsWithSize) {
        expect(resolveSizeSlugToId(boardName, layout.id, alias)).toBe(sizeId);
      }
    },
  );

  it.each(pinnedEntries)(
    'does not let $boardName "$alias" resolve on a layout without size $sizeId',
    ({ boardName, sizeId, alias }) => {
      const layoutWithoutSize = getAllLayouts(boardName).find(
        (layout) => !getSizesForLayoutId(boardName, layout.id).some((size) => size.id === sizeId),
      );
      expect(layoutWithoutSize).toBeDefined();
      if (!layoutWithoutSize) return;

      expect(resolveSizeSlugToId(boardName, layoutWithoutSize.id, alias)).toBeNull();
    },
  );

  it('never lets a pinned slug shadow a slug the generator still owns', () => {
    for (const { boardName, sizeId, alias } of pinnedEntries) {
      for (const layout of getAllLayouts(boardName)) {
        const generatedOwner = getSizesForLayoutId(boardName, layout.id).find(
          (size) => resolveSizeSlug(boardName, layout.id, size.id) === alias,
        );
        if (generatedOwner) {
          expect(generatedOwner.id, `${boardName} layout ${layout.id}: "${alias}" is generated for another size`).toBe(
            sizeId,
          );
        }
      }
    }
  });
});

describe("the Kilter 12 x 14 'Commerical' spelling correction (#4554)", () => {
  // Correcting Aurora's typo in the size description moved the generated URL
  // segment from `12x14-commerical` to `12x14-commercial`. PostHog counted 629
  // pageviews from 325 people on the old form in the 180 days to 2026-08-16 —
  // /list, /view, /playlists, and the /es and /fr variants — and the Expo app's
  // deep-link router resolves purely from board-constants with no database
  // fallback. These cases are the proof those links still land.
  it('mints the corrected slug for new links', () => {
    expect(resolveSizeSlug('kilter', 1, 7)).toBe('12x14-commercial');
    expect(generateSizeSlug('12 x 14', 'Commercial')).toBe('12x14-commercial');
  });

  it('still routes a climb link minted with the old spelling', () => {
    expect(parseClimbRoutePath(`/kilter/original/12x14-commerical/screw_bolt/40/view/${CLIMB_UUID}`)).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      angle: 40,
      climbUuid: CLIMB_UUID,
      surface: 'view',
    });
  });

  it('still routes a climb-list link minted with the old spelling', () => {
    expect(parseBoardListPath('/kilter/original/12x14-commerical/screw_bolt/40/list')).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 7,
      setIds: '1,20',
      angle: 40,
    });
  });

  it('routes the corrected slug to the same board', () => {
    expect(parseBoardListPath('/kilter/original/12x14-commercial/screw_bolt/40/list')?.sizeId).toBe(7);
  });
});
