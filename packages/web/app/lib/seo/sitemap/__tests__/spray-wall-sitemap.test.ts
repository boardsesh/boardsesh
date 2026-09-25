// SW-16 (#5449): the climbs of a PUBLIC spray wall are indexable; a private,
// unlisted, draft or deleted wall stays out, and the wall's own page stays out
// either way.
//
// Two kinds of test here, and the split is deliberate. The JS tests pin the
// consent token (`sprayWallSlug`) end to end — source → group → URL — and the
// `.toSQL()` tests render the SQL drizzle actually produces, because a test that
// restates the predicate it hopes is there is a tautology.

import { describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { isIndexableBoardType, isIndexableClimbConfig } from '../indexable-boards';
import {
  climbRowsToItems,
  resolveClimbSitemapGroups,
  type ClimbConfigGroup,
  type ClimbSitemapRow,
  type SitemapClimbConfig,
} from '../climb-entries';
import { boardConfigsToItems } from '../board-entries';

vi.mock('server-only', () => ({}));
// A drizzle instance with no client behind it: building and rendering a query
// never touches the connection, and the test must not need a database.
vi.mock('@/app/lib/db/db', () => ({ dbzRead: drizzle({} as never) }));
vi.mock('next/cache', () => ({ unstable_cache: <T>(work: T) => work }));

const { buildPublicSprayWallQuery } = await import('../spray-wall-configs');
const { buildTier2ClimbQuery } = await import('../climb-query');

const db = drizzle({} as never);

/** A wall as `getPublicSprayWallConfigs()` builds it: layout id, size id, one set. */
function sprayConfig(layoutId: number, sprayWallSlug?: string): SitemapClimbConfig {
  return {
    boardType: 'spray',
    layoutId,
    layoutName: "Marco's garage",
    sizeId: layoutId,
    sizeName: "Marco's garage",
    sizeDescription: "Marco's garage",
    setIds: [1],
    setNames: ['Holds'],
    climbCount: 42,
    totalAscents: 0,
    boardCount: 1,
    displayName: "Marco's garage",
    ...(sprayWallSlug ? { sprayWallSlug } : {}),
  };
}

/** Kilter layout 1 / size 10 / sets 1,20 — a configuration that really exists. */
const KILTER_CONFIG: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Original Layout',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: 'Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 500,
  totalAscents: 5_000,
  boardCount: 3,
  displayName: 'Kilter',
};

const SPRAY_ROWS: ClimbSitemapRow[] = [
  { uuid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Crimp Ladder', angle: 40, updatedAt: new Date('2026-09-01') },
  { uuid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: null, angle: 40, updatedAt: new Date('2026-09-02') },
];

describe('isIndexableClimbConfig', () => {
  it('indexes a public wall, which is the only spray config that carries a slug', () => {
    expect(isIndexableClimbConfig(sprayConfig(900, 'marcos-garage'))).toBe(true);
  });

  it('refuses a spray config with no slug — a wall nobody consented to publish', () => {
    expect(isIndexableClimbConfig(sprayConfig(900))).toBe(false);
    expect(isIndexableClimbConfig({ boardType: 'spray', sprayWallSlug: '' })).toBe(false);
  });

  it('leaves every other board type exactly where it was', () => {
    for (const boardType of [
      'kilter',
      'tension',
      'moonboard',
      'woods',
      'decoy',
      'grasshopper',
      'soill',
      'touchstone',
    ]) {
      expect(isIndexableClimbConfig({ boardType }), boardType).toBe(true);
    }
  });

  it('still withholds the spray board TYPE — a wall has no /list URL on www', () => {
    expect(isIndexableBoardType('spray')).toBe(false);
  });
});

describe('the climbs shard', () => {
  it('keeps a public wall and carries its slug through to the group', () => {
    const groups = resolveClimbSitemapGroups([sprayConfig(900, 'marcos-garage')]);
    expect(groups).toEqual([
      { boardType: 'spray', layoutId: 900, sizeId: 900, setIds: [1], boardSlug: 'marcos-garage' },
    ]);
  });

  it('drops a spray config with no slug, however many climbs it has', () => {
    expect(resolveClimbSitemapGroups([sprayConfig(900), sprayConfig(901)])).toEqual([]);
  });

  it('keeps the other boards alongside a wall', () => {
    // A real Kilter configuration — `resolveClimbSitemapGroups` also drops any
    // group whose segments have no readable URL, so an invented one would pass
    // this test for the wrong reason.
    const groups = resolveClimbSitemapGroups([KILTER_CONFIG, sprayConfig(900, 'marcos-garage')]);
    expect(groups.map((group) => group.boardType).sort()).toEqual(['kilter', 'spray']);
  });
});

describe('a spray wall climb URL', () => {
  const group: ClimbConfigGroup = {
    boardType: 'spray',
    layoutId: 900,
    sizeId: 900,
    setIds: [1],
    boardSlug: 'marcos-garage',
  };

  it('is the /b/{slug} front door, not a config tuple', () => {
    const { items, dropped } = climbRowsToItems(SPRAY_ROWS, group);
    expect(dropped).toBe(0);
    expect(items.map((item) => item.path)).toEqual([
      '/b/marcos-garage/40/view/crimp-ladder-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      // The unnamed climb goes through `resolveClimbDisplayName`, exactly as the
      // climb view page's own canonical does.
      '/b/marcos-garage/40/view/spray-climb-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    expect(items.map((item) => item.lastModified)).toEqual([new Date('2026-09-01'), new Date('2026-09-02')]);
  });

  it('emits nothing at all when the group has no slug', () => {
    const { items, dropped } = climbRowsToItems(SPRAY_ROWS, { ...group, boardSlug: undefined });
    expect(items).toEqual([]);
    expect(dropped).toBe(SPRAY_ROWS.length);
  });
});

describe('the boards shard', () => {
  it('still emits no list URL for a spray wall, public or not', () => {
    expect(boardConfigsToItems([sprayConfig(900, 'marcos-garage')])).toEqual([]);
    expect(boardConfigsToItems([sprayConfig(901)])).toEqual([]);
  });

  it('still emits one per angle for a real board', () => {
    const items = boardConfigsToItems([KILTER_CONFIG]);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => !item.path.includes('/spray/'))).toBe(true);
  });
});

function normalise(rendered: { sql: string; params: unknown[] }) {
  return { normalised: rendered.sql.toLowerCase().replace(/\s+/g, ' '), params: rendered.params };
}

describe('the public spray wall query', () => {
  const { normalised, params } = normalise(buildPublicSprayWallQuery(db).toSQL());

  it('selects only walls their owner made public', () => {
    expect(normalised).toMatch(/"user_boards"\."is_public" = \$\d+/);
    expect(params).toContain(true);
  });

  it('skips a deleted wall on either side of the join', () => {
    expect(normalised).toContain('"user_boards"."deleted_at" is null');
    expect(normalised).toContain('"spray_walls"."deleted_at" is null');
  });

  it('skips a wall whose first photo is still a draft', () => {
    expect(normalised).toContain('"spray_walls"."current_version_id" is not null');
  });

  it('needs a slug, because that is the whole URL', () => {
    expect(normalised).toContain('"user_boards"."slug" is not null');
  });

  it('counts only listed, non-draft, non-hidden climbs on the wall', () => {
    expect(normalised).toMatch(/"board_climbs"\."is_listed" = \$\d+/);
    expect(normalised).toMatch(/"board_climbs"\."is_draft" = \$\d+/);
    expect(normalised).toMatch(/"board_climbs"\."is_hidden" = \$\d+/);
    expect(params).toContain(false);
  });
});

describe('the tier-2 climbs query', () => {
  const KILTER_GROUP: ClimbConfigGroup = { boardType: 'kilter', layoutId: 1, sizeId: 127, setIds: [126, 131] };

  it('carries the spray visibility belt even on a Kilter group', () => {
    // Defence in depth: the predicate is a no-op on every non-spray row, and it
    // is what makes a private wall return zero rows if its layout ever reached a
    // group by another route.
    const { normalised } = normalise(buildTier2ClimbQuery(db, KILTER_GROUP).toSQL());
    expect(normalised).toContain('spray_walls');
    expect(normalised).toContain('is_public');
  });
});
