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
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
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

const auroraBoards = SUPPORTED_BOARDS.filter((boardName) => boardName !== 'moonboard');

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
