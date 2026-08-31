// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';

// `@/app/lib/slug-utils` imports `@/app/lib/db/db`, whose module body calls
// `createPool()`/`createDb()` at load time (the trap documented at
// `packages/web/app/__tests__/crawler-classic-invariant.test.ts:54-58`). The
// stub THROWS rather than returning empty rows: that turns the mock into a
// second assertion for this whole file — every catalogue slug must resolve
// off the static board tables (`getAllLayouts` / `getSizesForLayoutId` /
// `getSetsForLayoutAndSize`), so touching `dbz` at all is a failure rather
// than a silent DB fallback.
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({
  dbz: {
    select: () => {
      throw new Error('a catalogue slug fell through to the database');
    },
  },
}));

// `url-utils.server` calls these when a segment doesn't resolve. Throwing keeps
// a miss loud instead of returning `undefined` into the assertions below.
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound(): a segment this catalogue emitted did not parse back');
  },
  permanentRedirect: (target: string) => {
    throw new Error(`permanentRedirect('${target}'): the emitted path was not already canonical`);
  },
}));

import type { BoardName } from '@/app/lib/types';
import { AURORA_BOARDS, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { getAllLayouts, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import {
  PERMANENT_SIZE_SLUG_ALIASES,
  generateLayoutSlug,
  generateSetSlug,
  resolveSizeSlug,
} from '@boardsesh/play-view/readable-url-utils';
import { getLayoutBySlug, getSetsBySlug, getSizeBySlug } from '@/app/lib/slug-utils';
import { tryConstructSlugViewUrl } from '@/app/lib/url-utils';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE, type MoonBoardLayoutKey } from '@/app/lib/moonboard-config';
import { WOODS_LAYOUTS, WOODS_SETS, WOODS_SIZES } from '@/app/lib/woods-config';

/**
 * The acceptance criterion for #4362: a round-trip over the WHOLE catalogue
 * through `getSizeBySlug` — the async, DB-backed resolver every www climb URL
 * actually goes through (`url-utils.server.ts`). The sibling suite at
 * `packages/shared/play-view/src/__tests__/readable-url-utils.test.ts` already
 * round-trips the same catalogue through `resolveSizeSlugToId`; that is a
 * DIFFERENT resolver from web's `getSizeBySlug`, which layers its own
 * `findSizeBySlug` fallback and a DB leg on top. Nothing exercised that path
 * before this file.
 *
 * "The whole catalogue" here means every `(layout, size)` tuple reachable
 * through a *listed* layout — 42 today, not the 44 non-MoonBoard rows in
 * `product-sizes-data.ts`. `getSizesForLayoutId` drops 6 Kilter sizes whose
 * layouts (2-7) aren't in `LAYOUTS` and Grasshopper size 1, and that is the
 * same filter `resolveSizeSlug` and `getSizeBySlug` both apply — so a size it
 * drops has no emittable readable slug in the first place and nothing to
 * round-trip.
 *
 * Scoped to the static-tables leg only (the throwing `dbz` stub is
 * deliberate, see above) — `getSizeBySlug`'s DB leg (`findSizeBySlug` over
 * rows read from `product_sizes`) is NOT exercised here. That is acceptable
 * because every catalogue tuple this test walks resolves off the static
 * `@boardsesh/board-constants` tables (`getAllLayouts` / `getSizesForLayoutId`
 * / `getSetsForLayoutAndSize`) before `getSizeBySlug` ever reaches the DB
 * query; the DB leg exists only for a board config the static tables don't
 * carry, which no entry in this catalogue is. Covering that leg needs a
 * real-DB test (a stub rebuilding the DB predicate would be a tautology, per
 * the repo's SQL-stub testing convention) and is out of scope here.
 */

/**
 * MoonBoard is walked by its own suite at the bottom of this file rather than by
 * the loop below. It carries no rows in `@boardsesh/board-constants`' layout and
 * product-size tables — its catalogue is the static `MOONBOARD_LAYOUTS` /
 * `MOONBOARD_SETS` objects — so `getAllLayouts('moonboard')` is empty and this
 * loop would walk zero tuples for it while still reporting green. The split is
 * which TABLE each arm reads, not which board is covered; the coverage assertion
 * below pins the static arms plus the separately server-driven Quantum catalog
 * together cover `SUPPORTED_BOARDS`.
 */
/**
 * Woods is split out for the same reason as MoonBoard: it carries no rows in
 * `@boardsesh/board-constants`' layout and set tables, so `getAllLayouts('woods')`
 * is empty and this loop would walk zero tuples while still reporting green. Its
 * arm is `Woods board URL segments` at the bottom of this file.
 */
const auroraBoards = AURORA_BOARDS;

/**
 * Tuples each board carries today. Asserted per board inside the round-trip
 * loop so a `continue` that quietly stops walking part of the catalogue reds
 * the loop that skipped it — rather than being re-derived by a second walk,
 * which would only ever guard the catalogue data.
 */
const EXPECTED_TUPLE_FLOOR: Record<string, number> = {
  kilter: 16,
  tension: 15,
  decoy: 3,
  touchstone: 1,
  grasshopper: 5,
  soill: 2,
};

const ROUND_TRIP_ANGLE = 40;

describe('getSizeBySlug catalogue round-trip (the resolver a www URL actually goes through)', () => {
  it.each(auroraBoards)('%s: every emitted board URL segment resolves back to its own ids', async (boardName) => {
    let checked = 0;

    for (const layout of getAllLayouts(boardName)) {
      for (const size of getSizesForLayoutId(boardName, layout.id)) {
        const sets = getSetsForLayoutAndSize(boardName, layout.id, size.id);
        if (sets.length === 0) continue;

        const setIds = sets.map((set) => set.id);
        const sortedSetIds = [...setIds].sort((a, b) => a - b);
        const label = `${boardName} / ${layout.name} / ${size.name} (size id ${size.id})`;

        const sizeSlug = resolveSizeSlug(boardName, layout.id, size.id);
        expect(sizeSlug, `${label}: resolveSizeSlug returned null`).not.toBeNull();

        // The acceptance criterion.
        const resolvedSize = await getSizeBySlug(boardName, layout.id, sizeSlug!);
        expect(resolvedSize?.id, `${label}: getSizeBySlug('${sizeSlug}') → ${resolvedSize?.id}`).toBe(size.id);

        const layoutSlug = generateLayoutSlug(layout.name);
        const resolvedLayout = await getLayoutBySlug(boardName, layoutSlug);
        expect(resolvedLayout?.id, `${label}: getLayoutBySlug('${layoutSlug}') → ${resolvedLayout?.id}`).toBe(
          layout.id,
        );

        const setSlug = generateSetSlug(sets.map((set) => set.name));
        const resolvedSets = await getSetsBySlug(boardName, layout.id, size.id, setSlug);
        expect(
          resolvedSets.map((set) => set.id).sort((a, b) => a - b),
          `${label}: getSetsBySlug('${setSlug}')`,
        ).toEqual(sortedSetIds);

        // The invariant a climber actually experiences: the path the emitter
        // builds, fed to the parser the route handlers use, comes back as the
        // ids it started from. The three assertions above compare each segment
        // against a slug this test re-derived, so they can only catch a
        // resolver/emitter disagreement per segment — a composition bug in
        // `tryConstructSlugViewUrl` (segments in the wrong order, one dropped,
        // a stray prefix) would sail past them. The uuid is Aurora-shaped
        // because the parser pulls it off the end of the `crimpy-thing-<uuid>`
        // segment with a 32-hex-char match.
        const climbUuid = `${layout.id}${size.id}`.padStart(32, '0');
        const emittedPath = tryConstructSlugViewUrl(
          boardName,
          layout.id,
          size.id,
          setIds,
          ROUND_TRIP_ANGLE,
          climbUuid,
          'Round Trip',
        );
        expect(emittedPath, `${label}: tryConstructSlugViewUrl returned null`).not.toBeNull();

        const [, emittedBoard, emittedLayout, emittedSize, emittedSets, emittedAngle, surface, emittedClimb] =
          emittedPath!.split('/');
        expect(surface, `${label}: emitted path ${emittedPath}`).toBe('view');

        const parsed = await parseBoardRouteParamsWithSlugs({
          board_name: emittedBoard,
          layout_id: emittedLayout,
          size_id: emittedSize,
          set_ids: emittedSets,
          angle: emittedAngle,
          climb_uuid: emittedClimb,
        });
        expect(
          {
            board_name: parsed.board_name,
            layout_id: parsed.layout_id,
            size_id: parsed.size_id,
            set_ids: [...parsed.set_ids].sort((a, b) => a - b),
            angle: parsed.angle,
            climb_uuid: parsed.climb_uuid,
          },
          `${label}: ${emittedPath} did not parse back to its own ids`,
        ).toEqual({
          board_name: boardName,
          layout_id: layout.id,
          size_id: size.id,
          set_ids: sortedSetIds,
          angle: ROUND_TRIP_ANGLE,
          climb_uuid: climbUuid,
        });

        checked += 1;
      }
    }

    expect(checked, `${boardName}: walked fewer tuples than the catalogue carries`).toBeGreaterThanOrEqual(
      EXPECTED_TUPLE_FLOOR[boardName],
    );
  });

  it('covers every Aurora board, for the verified catalogue size of 42 tuples', () => {
    expect(Object.keys(EXPECTED_TUPLE_FLOOR).sort()).toEqual([...auroraBoards].sort());
    expect(Object.values(EXPECTED_TUPLE_FLOOR).reduce((total, count) => total + count, 0)).toBe(42);
  });
});

describe('the Kilter 12x12 pair, through the resolver a www URL actually goes through', () => {
  it('gives size 10 ("with kickboard") and size 27 ("without kickboard") distinct slugs that each resolve back', async () => {
    expect(resolveSizeSlug('kilter', 1, 10)).toBe('12x12-square');
    expect(resolveSizeSlug('kilter', 1, 27)).toBe('12x12-square-without-kickboard');

    expect((await getSizeBySlug('kilter', 1, '12x12-square'))?.id).toBe(10);
    expect((await getSizeBySlug('kilter', 1, '12x12-square-without-kickboard'))?.id).toBe(27);
  });
});

/**
 * Deliberately narrow: this asserts the *pinned strings* still resolve to their
 * pinned ids through web's resolver, whichever branch of `resolveSizeSlugToId`
 * happens to match. It is NOT a guard on the alias branch being consulted —
 * both entries pinned today are byte-identical to the slug the generated branch
 * already emits, so the alias branch is never reached from here. That branch is
 * covered in `packages/shared/play-view/src/__tests__/readable-url-utils.test.ts`,
 * which mutation-tests it directly. What this adds is that the pinned contract
 * holds on web's side of the resolver split too, for every board in the table.
 */
describe('the pinned PERMANENT_SIZE_SLUG_ALIASES strings resolve through getSizeBySlug', () => {
  it('resolves each pinned slug to its pinned size id, on every layout that carries that size', async () => {
    const pinnedBoards = Object.entries(PERMANENT_SIZE_SLUG_ALIASES);
    expect(pinnedBoards.length).toBeGreaterThan(0);

    let resolvedAliases = 0;

    for (const [pinnedBoardName, aliasesBySizeId] of pinnedBoards) {
      const boardName = pinnedBoardName as BoardName;

      for (const [sizeIdString, aliases] of Object.entries(aliasesBySizeId ?? {})) {
        const pinnedSizeId = Number(sizeIdString);
        const layoutsCarryingSize = getAllLayouts(boardName).filter((layout) =>
          getSizesForLayoutId(boardName, layout.id).some((size) => size.id === pinnedSizeId),
        );
        expect(
          layoutsCarryingSize.length,
          `no listed ${boardName} layout carries pinned size ${pinnedSizeId}`,
        ).toBeGreaterThan(0);

        for (const layout of layoutsCarryingSize) {
          for (const alias of aliases) {
            const resolved = await getSizeBySlug(boardName, layout.id, alias);
            expect(
              resolved?.id,
              `${boardName} layout ${layout.id}: alias '${alias}' should still resolve to size ${pinnedSizeId}`,
            ).toBe(pinnedSizeId);
            resolvedAliases += 1;
          }
        }
      }
    }

    expect(resolvedAliases).toBeGreaterThan(0);
  });
});

/**
 * The MoonBoard arm. Until this shipped, MoonBoard was filtered out of this file
 * entirely — which is exactly why `getMoonBoardSetsBySlug`'s `-`-splitting
 * substring matcher survived: nothing ever fed a MoonBoard path it emitted back
 * through `parseBoardRouteParamsWithSlugs`.
 *
 * Every non-empty subset, not just the full set: a MoonBoard URL names whichever
 * hold sets are installed on that wall, `getMoonBoardDetails` turns the parsed
 * ids into the hold-set background images the board renders, and a parser that
 * resolves `hold-set-a` to all three 2016 sets draws holds the URL never asked
 * for. 291 tuples across the seven layouts.
 */
function nonEmptySetSubsets(setIds: readonly number[]): number[][] {
  const subsets: number[][] = [];
  for (let mask = 1; mask < 1 << setIds.length; mask += 1) {
    subsets.push(setIds.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

const moonBoardLayoutKeys = Object.keys(MOONBOARD_LAYOUTS) as MoonBoardLayoutKey[];

/** 32 hex characters in the dashed 8-4-4-4-12 form MoonBoard climbs actually use. */
function toDashedUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe('MoonBoard catalogue round-trip (the static tables, through the same www resolver)', () => {
  it.each(moonBoardLayoutKeys)(
    '%s: every emitted set-slug subset parses back to the ids it was built from',
    async (layoutKey) => {
      const layout = MOONBOARD_LAYOUTS[layoutKey];
      const allSetIds = MOONBOARD_SETS[layoutKey].map((set) => set.id);
      const subsets = nonEmptySetSubsets(allSetIds);

      expect(subsets.length, `${layoutKey}: no set subsets to walk`).toBe(2 ** allSetIds.length - 1);

      for (const setIds of subsets) {
        const label = `${layoutKey} / sets [${setIds.join(',')}]`;
        // Dashed, because that is the only shape MoonBoard has: every one of the
        // 142,566 MoonBoard rows on the dev image carries a 36-character
        // RFC-4122 uuid, and no other board does. An Aurora-shaped 32-hex uuid
        // here would leave the climb segment untested — the uuid extractor
        // matched only the unbroken form, so a real MoonBoard climb URL parsed
        // back with its whole `<name>-<uuid>` segment as the uuid and 404'd.
        const climbUuid = toDashedUuid(`${layout.id}${setIds.join('')}`.padStart(32, '0'));

        const emittedPath = tryConstructSlugViewUrl(
          'moonboard',
          layout.id,
          MOONBOARD_SIZE.id,
          setIds,
          ROUND_TRIP_ANGLE,
          climbUuid,
          'Round Trip',
        );
        expect(emittedPath, `${label}: tryConstructSlugViewUrl returned null`).not.toBeNull();

        const [, emittedBoard, emittedLayout, emittedSize, emittedSets, emittedAngle, surface, emittedClimb] =
          emittedPath!.split('/');
        expect(surface, `${label}: emitted path ${emittedPath}`).toBe('view');

        const parsed = await parseBoardRouteParamsWithSlugs({
          board_name: emittedBoard,
          layout_id: emittedLayout,
          size_id: emittedSize,
          set_ids: emittedSets,
          angle: emittedAngle,
          climb_uuid: emittedClimb,
        });

        expect(
          {
            board_name: parsed.board_name,
            layout_id: parsed.layout_id,
            size_id: parsed.size_id,
            set_ids: [...parsed.set_ids].sort((left, right) => left - right),
            angle: parsed.angle,
            climb_uuid: parsed.climb_uuid,
          },
          `${label}: ${emittedPath} did not parse back to its own ids`,
        ).toEqual({
          board_name: 'moonboard',
          layout_id: layout.id,
          size_id: MOONBOARD_SIZE.id,
          set_ids: [...setIds].sort((left, right) => left - right),
          angle: ROUND_TRIP_ANGLE,
          climb_uuid: climbUuid,
        });
      }
    },
  );

  it('walks all 291 subsets, and the catalog arms classify every supported board', () => {
    const walked = moonBoardLayoutKeys.reduce(
      (total, layoutKey) => total + 2 ** MOONBOARD_SETS[layoutKey].length - 1,
      0,
    );
    expect(walked).toBe(291);
    // Quantum geometry is imported from its signed catalog at runtime, so it
    // deliberately has no static www tuple in this round-trip suite.
    expect([...auroraBoards, 'moonboard', 'woods', 'quantum'].sort()).toEqual([...SUPPORTED_BOARDS].sort());
  });

  it('keeps runtime-only Quantum geometry out of legacy www routes', async () => {
    await expect(
      parseBoardRouteParamsWithSlugs({
        board_name: 'quantum',
        layout_id: '9101',
        size_id: '9201',
        set_ids: '1',
        angle: '40',
      }),
    ).rejects.toThrow(/notFound\(\)/);
  });
});

/**
 * The other half of the parser's contract, which the round-trip above cannot
 * reach: what happens to a set slug this app never emitted.
 *
 * The round-trip only ever feeds back slugs `generateSetSlug` built, and those
 * rebuild by construction — so it stays green with the rebuild check deleted.
 * These cases are what that check is for. A reordered or repeated slug is not a
 * form www or the Expo app mints, so it is not authoritative about which sets
 * are on the wall; it falls through to the layout's full set rather than
 * silently deciding the URL meant a subset.
 */
describe('MoonBoard set slugs this app never emits', () => {
  const layoutsWithSeveralSets = moonBoardLayoutKeys.filter((layoutKey) => MOONBOARD_SETS[layoutKey].length >= 2);

  async function parseSetSlug(layoutKey: MoonBoardLayoutKey, setSlug: string): Promise<number[]> {
    const parsed = await parseBoardRouteParamsWithSlugs({
      board_name: 'moonboard',
      layout_id: generateLayoutSlug(MOONBOARD_LAYOUTS[layoutKey].name),
      size_id: 'standard-11x18-grid',
      set_ids: setSlug,
      angle: String(ROUND_TRIP_ANGLE),
    });
    return [...parsed.set_ids].sort((left, right) => left - right);
  }

  it.each(layoutsWithSeveralSets)('%s: a reordered two-set slug falls back to every set', async (layoutKey) => {
    const pair = MOONBOARD_SETS[layoutKey].slice(0, 2);
    const canonical = generateSetSlug(pair.map((set) => set.name));
    const reordered = canonical.split('_').reverse().join('_');

    // Without this the case is vacuous: a symmetric slug would prove nothing.
    expect(reordered, `${layoutKey}: reversing '${canonical}' changed nothing`).not.toBe(canonical);

    expect(await parseSetSlug(layoutKey, canonical)).toEqual(pair.map((set) => set.id).sort((a, b) => a - b));
    expect(await parseSetSlug(layoutKey, reordered)).toEqual(
      MOONBOARD_SETS[layoutKey].map((set) => set.id).sort((a, b) => a - b),
    );
  });

  it.each(layoutsWithSeveralSets)('%s: a repeated part falls back to every set', async (layoutKey) => {
    const [firstSet] = MOONBOARD_SETS[layoutKey];
    const onePart = generateSetSlug([firstSet.name]);

    expect(await parseSetSlug(layoutKey, onePart)).toEqual([firstSet.id]);
    expect(await parseSetSlug(layoutKey, `${onePart}_${onePart}`)).toEqual(
      MOONBOARD_SETS[layoutKey].map((set) => set.id).sort((a, b) => a - b),
    );
  });

  it.each(moonBoardLayoutKeys)('%s: an unrecognised slug still renders the whole layout', async (layoutKey) => {
    expect(await parseSetSlug(layoutKey, 'holds-that-do-not-exist')).toEqual(
      MOONBOARD_SETS[layoutKey].map((set) => set.id).sort((a, b) => a - b),
    );
  });
});

/**
 * The Woods arm. Woods is code-driven like MoonBoard — one layout, two sizes and
 * a single synthetic hold set — so its segments are resolved by a static branch
 * in `url-utils.server.ts` rather than by the slug resolvers above. Every shape a
 * Woods URL can take has to land on the same ids, and the set segment has to
 * resolve to `[1]` rather than an empty list: an empty set list mis-parses the
 * `board/layout/size/sets/angle` path and breaks the board builder.
 */
describe('Woods board URL segments', () => {
  /** An unbroken 32-hex uuid — the shape the Woods importer mints. */
  const WOODS_CLIMB_UUID = '00d5b1a7c4e9f2360a1b2c3d4e5f6071';

  async function parseWoods(layoutSegment: string, sizeSegment: string, setSegment: string) {
    const parsed = await parseBoardRouteParamsWithSlugs({
      board_name: 'woods',
      layout_id: layoutSegment,
      size_id: sizeSegment,
      set_ids: setSegment,
      angle: String(ROUND_TRIP_ANGLE),
    });
    return { layoutId: parsed.layout_id, sizeId: parsed.size_id, setIds: parsed.set_ids, angle: parsed.angle };
  }

  it.each([
    ['original', '8x10', 'standard', 1],
    ['original', '8-10', 'standard', 1],
    ['1', '1', '1', 1],
    ['original', '12x12', 'standard', 2],
    ['original', '12-12', 'standard', 2],
    ['1', '2', '1', 2],
  ])('resolves /woods/%s/%s/%s to size %i', async (layoutSegment, sizeSegment, setSegment, expectedSizeId) => {
    expect(await parseWoods(String(layoutSegment), String(sizeSegment), String(setSegment))).toEqual({
      layoutId: 1,
      sizeId: expectedSizeId,
      setIds: [1],
      angle: ROUND_TRIP_ANGLE,
    });
  });

  it('resolves an empty set segment to the synthetic set rather than no sets', async () => {
    expect((await parseWoods('original', '12x12', '')).setIds).toEqual([1]);
  });

  /**
   * Woods has exactly one (layout, size, set) catalogue, so any segment outside it
   * names a board that does not exist and has to 404 — the `next/navigation` mock
   * at the top of this file turns `notFound()` into a throw. Before this, an
   * unknown numeric size passed straight through and `getWoodsBoardDetails` threw
   * on it (a 500, not a 404), an unknown size slug silently rendered the 8×10
   * board, and the layout and set segments were not checked at all.
   */
  it.each([
    ['unknown numeric size', 'original', '99', 'standard'],
    ['unknown size slug', 'original', '9x9', 'standard'],
    ['unknown dashed size slug', 'original', '9-9', 'standard'],
    ['unknown numeric layout', '99', '12x12', 'standard'],
    ['unknown layout slug', 'benchmark', '12x12', 'standard'],
    ['a set that does not exist', 'original', '12x12', '2'],
    ['more sets than Woods has', 'original', '12x12', '1,2'],
    ['unknown set slug', 'original', '12x12', 'crimps'],
  ])('404s %s', async (_case, layoutSegment, sizeSegment, setSegment) => {
    await expect(parseWoods(layoutSegment, sizeSegment, setSegment)).rejects.toThrow(/notFound\(\)/);
  });

  /**
   * The other half of the contract: what www itself emits has to parse back
   * here. Both sizes, because the 8x10 and the 12x12 number their holds from
   * their own origins — landing on the wrong one silently draws a different
   * climb rather than failing.
   */
  it.each([
    [WOODS_SIZES['8x10'].id, '8x10'],
    [WOODS_SIZES['12x12'].id, '12x12'],
  ])('size %i: the URL www emits parses back to its own ids', async (sizeId, expectedSizeSlug) => {
    const setIds = WOODS_SETS.map((woodsSet) => woodsSet.id);
    const emittedPath = tryConstructSlugViewUrl(
      'woods',
      WOODS_LAYOUTS.woods.id,
      sizeId,
      setIds,
      ROUND_TRIP_ANGLE,
      WOODS_CLIMB_UUID,
      'Round Trip',
    );
    expect(emittedPath, `woods size ${sizeId}: tryConstructSlugViewUrl returned null`).not.toBeNull();

    const [, emittedBoard, emittedLayout, emittedSize, emittedSets, emittedAngle, surface, emittedClimb] =
      emittedPath!.split('/');
    expect(surface, `woods size ${sizeId}: emitted path ${emittedPath}`).toBe('view');
    expect(emittedSize).toBe(expectedSizeSlug);

    const parsed = await parseBoardRouteParamsWithSlugs({
      board_name: emittedBoard,
      layout_id: emittedLayout,
      size_id: emittedSize,
      set_ids: emittedSets,
      angle: emittedAngle,
      climb_uuid: emittedClimb,
    });

    expect(
      {
        board_name: parsed.board_name,
        layout_id: parsed.layout_id,
        size_id: parsed.size_id,
        set_ids: [...parsed.set_ids].sort((left, right) => left - right),
        angle: parsed.angle,
        climb_uuid: parsed.climb_uuid,
      },
      `woods size ${sizeId}: ${emittedPath} did not parse back to its own ids`,
    ).toEqual({
      board_name: 'woods',
      layout_id: WOODS_LAYOUTS.woods.id,
      size_id: sizeId,
      set_ids: [...setIds].sort((left, right) => left - right),
      angle: ROUND_TRIP_ANGLE,
      climb_uuid: WOODS_CLIMB_UUID,
    });
  });
});
