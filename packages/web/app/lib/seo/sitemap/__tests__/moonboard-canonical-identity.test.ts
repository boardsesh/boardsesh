// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';

// Same trap as `slug-utils-catalogue-round-trip.test.ts`: `url-utils.server`
// pulls in `@/app/lib/db/db`, whose module body opens a pool at load time. The
// stub throws rather than returning rows, so "MoonBoard resolves entirely off
// the static tables" is an assertion of this file rather than an assumption.
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({
  dbz: {
    select: () => {
      throw new Error('a MoonBoard sitemap URL fell through to the database');
    },
  },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound(): a URL this sitemap emitted did not parse back');
  },
  permanentRedirect: (target: string) => {
    throw new Error(`permanentRedirect('${target}'): the emitted path was not already canonical`);
  },
}));

import { ANGLES, getDefaultRenderBoard } from '@boardsesh/board-config';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE, type MoonBoardLayoutKey } from '@/app/lib/moonboard-config';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbListUrl, buildCanonicalClimbViewUrl, popularConfigListUrl } from '@/app/lib/url-utils';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { climbRowsToItems, type ClimbConfigGroup } from '../climb-entries';

/**
 * The property the whole MoonBoard sitemap turns on: a URL the shard submits is
 * byte-identical to the `<link rel="canonical">` the page it points at renders.
 *
 * Not three per-segment comparisons — the composition. `climbRowsToItems` builds
 * the path, `parseBoardRouteParamsWithSlugs` is what the route handler runs on
 * it, `getBoardDetailsForBoard` is what `generateMetadata` calls on the result,
 * and `buildCanonicalClimbViewUrl` is the builder that emits the canonical. Any
 * disagreement anywhere along that chain — a set slug that parses back to a
 * different id list, a segment reordered, a display name resolved on one side
 * only — shows up here as two different strings.
 *
 * It goes red on the parser this replaced for masters-2017 and masters-2019,
 * whose full-set slugs lost `Screw-on Feet` on the way back in, which is the
 * proof it is not vacuous.
 */

const MOONBOARD_LAYOUT_KEYS = Object.keys(MOONBOARD_LAYOUTS) as MoonBoardLayoutKey[];

/** The full-set group per layout — exactly what the sitemap config source emits. */
function fullSetGroup(layoutKey: MoonBoardLayoutKey): ClimbConfigGroup {
  return {
    boardType: 'moonboard',
    layoutId: MOONBOARD_LAYOUTS[layoutKey].id,
    sizeId: MOONBOARD_SIZE.id,
    setIds: MOONBOARD_SETS[layoutKey].map((set) => set.id),
  };
}

function syntheticConfig(layoutKey: MoonBoardLayoutKey): PopularBoardConfig {
  const group = fullSetGroup(layoutKey);
  return {
    boardType: 'moonboard',
    layoutId: group.layoutId,
    layoutName: MOONBOARD_LAYOUTS[layoutKey].name,
    sizeId: group.sizeId,
    sizeName: MOONBOARD_SIZE.name,
    sizeDescription: MOONBOARD_SIZE.description,
    setIds: group.setIds,
    setNames: MOONBOARD_SETS[layoutKey].map((set) => set.name),
    boardCount: 0,
    climbCount: 1,
    totalAscents: 0,
    displayName: MOONBOARD_LAYOUTS[layoutKey].name,
  };
}

/** `/moonboard/{layout}/{size}/{sets}/{angle}/view/{slug-uuid}` → the parsed tuple. */
async function parseViewPath(path: string) {
  const [, boardName, layoutSlug, sizeSlug, setSlug, angle, surface, climbSegment] = path.split('/');
  expect(surface, `expected a /view/ path, got ${path}`).toBe('view');
  return parseBoardRouteParamsWithSlugs({
    board_name: boardName,
    layout_id: layoutSlug,
    size_id: sizeSlug,
    set_ids: setSlug,
    angle,
    climb_uuid: climbSegment,
  });
}

/** `/moonboard/{layout}/{size}/{sets}/{angle}/list` → the parsed tuple. */
async function parseListPath(path: string) {
  const [, boardName, layoutSlug, sizeSlug, setSlug, angle, surface] = path.split('/');
  expect(surface, `expected a /list path, got ${path}`).toBe('list');
  return parseBoardRouteParamsWithSlugs({
    board_name: boardName,
    layout_id: layoutSlug,
    size_id: sizeSlug,
    set_ids: setSlug,
    angle,
  });
}

describe('MoonBoard sitemap URLs are self-canonical', () => {
  it.each(MOONBOARD_LAYOUT_KEYS)(
    '%s: every emitted climb URL rebuilds itself through the page’s own canonical builder',
    async (layoutKey) => {
      const group = fullSetGroup(layoutKey);

      // Two rows so an unnamed climb — the one whose canonical carries the
      // `-moonboard-climb-` display-name slug — is covered alongside a named one.
      //
      // Both uuids are real MoonBoard uuids off the dev image, and the shape is
      // load-bearing: MoonBoard is the only board whose climbs carry the dashed
      // 36-character form (142,566 of them; every Aurora board is 32 unbroken
      // hex). An `'aaaa…'` fixture matches the uuid extractor's 32-hex rule and
      // therefore proves nothing about the segment a real MoonBoard row emits.
      const rows = [
        { uuid: '9fe54099-6fdd-5adb-b82f-2d7bcb10d4ad', name: 'Slab Dancer', angle: 0, updatedAt: new Date(0) },
        { uuid: '28510d27-9e46-5f30-8d6b-4c9dbb2d1f70', name: null, angle: 0, updatedAt: new Date(0) },
      ];

      for (const angle of ANGLES.moonboard) {
        const { items, dropped } = climbRowsToItems(
          rows.map((row) => ({ ...row, angle })),
          group,
        );
        expect(dropped, `${layoutKey} @ ${angle}: rows dropped`).toBe(0);
        expect(items).toHaveLength(rows.length);

        for (const [index, item] of items.entries()) {
          const parsed = await parseViewPath(item.path);

          // The tuple the page resolves must be the tuple the sitemap named —
          // otherwise the canonical below could still match while the page
          // renders a different set of holds.
          expect(
            [...parsed.set_ids].sort((left, right) => left - right),
            `${layoutKey} @ ${angle}: ${item.path}`,
          ).toEqual([...group.setIds].sort((left, right) => left - right));
          expect(parsed.layout_id).toBe(group.layoutId);
          expect(parsed.size_id).toBe(group.sizeId);
          expect(parsed.angle).toBe(angle);

          // The uuid the route hands `getClimb`. Without this the canonical
          // below still matches — `buildCanonicalClimbViewUrl` re-slugs whatever
          // it is given, so a segment that failed to yield its uuid rebuilds the
          // same string — while the page itself 404s on a climb nobody has.
          expect(parsed.climb_uuid, `${layoutKey} @ ${angle}: ${item.path}`).toBe(rows[index].uuid);

          const canonical = buildCanonicalClimbViewUrl(
            getBoardDetailsForBoard(parsed),
            parsed.angle,
            parsed.climb_uuid,
            resolveClimbDisplayName(rows[index].name, group.boardType),
          );
          expect(canonical, `${layoutKey} @ ${angle}: sitemap emitted ${item.path}`).toBe(item.path);
        }
      }
    },
  );

  it.each(MOONBOARD_LAYOUT_KEYS)('%s: the boards-shard list URL is self-canonical too', async (layoutKey) => {
    const config = syntheticConfig(layoutKey);

    for (const angle of ANGLES.moonboard) {
      const listPath = popularConfigListUrl(config, angle);

      // The `//` guard is the empty-path-segment shape `popularConfigListUrl`
      // falls into when its name branch is reached with an empty `setNames` —
      // a 404 handed straight to Google.
      expect(listPath, `${layoutKey} @ ${angle}`).not.toContain('//');
      expect(listPath.endsWith(`/${angle}/list`), `${layoutKey} @ ${angle}: ${listPath}`).toBe(true);

      const parsed = await parseListPath(listPath);
      expect(buildCanonicalClimbListUrl(getBoardDetailsForBoard(parsed), parsed.angle)).toBe(listPath);
    }
  });

  it('the full-set tuples are the ones the shared render-board resolver already names', () => {
    // Two claims, and the second is the one the title is about.
    //
    // 1. The fixtures this whole file canonicalises are the literal tuples
    //    below — written out, not re-derived, so a table that started emitting
    //    a partial set list has something to disagree with.
    const literalTuples = [
      { boardType: 'moonboard', layoutId: 1, sizeId: 1, setIds: [1] },
      { boardType: 'moonboard', layoutId: 2, sizeId: 1, setIds: [2, 3, 4] },
      { boardType: 'moonboard', layoutId: 3, sizeId: 1, setIds: [5, 6, 7, 8, 9, 10] },
      { boardType: 'moonboard', layoutId: 4, sizeId: 1, setIds: [11, 12, 13, 14, 15, 16] },
      { boardType: 'moonboard', layoutId: 5, sizeId: 1, setIds: [17, 18, 19, 20, 21, 22, 23] },
      { boardType: 'moonboard', layoutId: 6, sizeId: 1, setIds: [24, 25, 26, 27] },
      { boardType: 'moonboard', layoutId: 7, sizeId: 1, setIds: [28, 29, 30, 31] },
    ];
    expect(MOONBOARD_LAYOUT_KEYS.map((layoutKey) => fullSetGroup(layoutKey))).toEqual(literalTuples);

    // 2. `getDefaultRenderBoard` — the function `board-config-source.ts`
    //    actually derives the shipped configs from — names those same tuples.
    //    Without this leg the whole suite would keep canonicalising tuples the
    //    shard had stopped emitting: `fullSetGroup` reads `MOONBOARD_SETS`
    //    directly, so a resolver that began returning a subset for MoonBoard
    //    would drift away silently and every case here would stay green.
    expect(
      literalTuples.map(({ layoutId }) => {
        const renderBoard = getDefaultRenderBoard('moonboard', layoutId);
        return {
          boardType: 'moonboard',
          layoutId: renderBoard?.layoutId,
          sizeId: renderBoard?.sizeId,
          setIds: renderBoard?.setIds,
        };
      }),
    ).toEqual(literalTuples);
  });
});
