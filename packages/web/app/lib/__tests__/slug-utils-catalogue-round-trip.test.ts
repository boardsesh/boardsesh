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

import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { getAllLayouts, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import {
  PERMANENT_SIZE_SLUG_ALIASES,
  generateLayoutSlug,
  generateSetSlug,
  resolveSizeSlug,
} from '@boardsesh/play-view/readable-url-utils';
import { getLayoutBySlug, getSetsBySlug, getSizeBySlug } from '@/app/lib/slug-utils';

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

describe('getSizeBySlug catalogue round-trip (the resolver a www URL actually goes through)', () => {
  it.each(auroraBoards)('%s: every emitted board URL segment resolves back to its own ids', async (boardName) => {
    let checked = 0;

    for (const layout of getAllLayouts(boardName)) {
      for (const size of getSizesForLayoutId(boardName, layout.id)) {
        const sets = getSetsForLayoutAndSize(boardName, layout.id, size.id);
        if (sets.length === 0) continue;

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
        ).toEqual(sets.map((set) => set.id).sort((a, b) => a - b));

        checked += 1;
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('checks at least the verified catalogue size (42 tuples across the 6 Aurora boards)', async () => {
    let checked = 0;

    for (const boardName of auroraBoards) {
      for (const layout of getAllLayouts(boardName)) {
        for (const size of getSizesForLayoutId(boardName, layout.id)) {
          const sets = getSetsForLayoutAndSize(boardName, layout.id, size.id);
          if (sets.length === 0) continue;
          checked += 1;
        }
      }
    }

    expect(checked).toBeGreaterThanOrEqual(42);
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

describe("PERMANENT_SIZE_SLUG_ALIASES survive web's resolver too, not just play-view's", () => {
  it('resolves every pinned Kilter alias through getSizeBySlug to its pinned size id', async () => {
    const kilterAliases = PERMANENT_SIZE_SLUG_ALIASES.kilter ?? {};
    const pinnedEntries = Object.entries(kilterAliases);
    expect(pinnedEntries.length).toBeGreaterThan(0);

    for (const [sizeIdString, aliases] of pinnedEntries) {
      const pinnedSizeId = Number(sizeIdString);
      for (const alias of aliases) {
        const resolved = await getSizeBySlug('kilter', 1, alias);
        expect(resolved?.id, `alias '${alias}' should still resolve to size ${pinnedSizeId}`).toBe(pinnedSizeId);
      }
    }
  });
});
