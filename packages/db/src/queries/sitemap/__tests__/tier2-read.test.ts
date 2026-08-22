import { describe, expect, it } from 'vite-plus/test';
import { planTier2Pages, verifyTier2Table, type Tier2GroupRow } from '../tier2-read';
import type { ClimbConfigGroup } from '../tier2-groups';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const FINGERPRINT = 'aaaaaaaaaaaaaaaa';

function group(overrides: Partial<Tier2GroupRow> = {}): Tier2GroupRow {
  return {
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 27,
    setIds: [26, 31],
    itemCount: 40_000,
    lastModified: new Date('2026-08-20T00:00:00.000Z'),
    predicateFingerprint: FINGERPRINT,
    refreshedAt: new Date('2026-08-21T02:20:00.000Z'),
    ...overrides,
  };
}

function verify(input: {
  storedGroups: Tier2GroupRow[];
  resolvedGroups?: ClimbConfigGroup[] | null;
  runtimeFingerprint?: string;
  isResolvable?: (group: ClimbConfigGroup) => boolean;
}) {
  return verifyTier2Table({
    storedGroups: input.storedGroups,
    resolvedGroups: input.resolvedGroups ?? null,
    runtimeFingerprint: input.runtimeFingerprint ?? FINGERPRINT,
    isResolvable: input.isResolvable ?? (() => true),
    now: NOW,
  });
}

describe('verifyTier2Table', () => {
  it('falls back when nothing has been refreshed', () => {
    const verdict = verify({ storedGroups: [] });
    expect(verdict.source).toBe('live');
    expect(verdict.reason).toBe('empty');
  });

  it('falls back when the stored rows were selected by a different predicate', () => {
    // The rows describe a different set than the code now selects. A tightened
    // angle filter, for one, would have us submitting URLs that 404 today — and
    // submitting 404s is worse than a degraded index.
    const verdict = verify({ storedGroups: [group()], runtimeFingerprint: 'bbbbbbbbbbbbbbbb' });
    expect(verdict.source).toBe('live');
    expect(verdict.reason).toBe('predicate-drift');
  });

  it('SERVES a stale table rather than falling back, and says how stale', () => {
    // The least obvious decision in this design, and the one most likely to be
    // "helpfully" undone. A live scan blows SHARD_DEADLINE_MS and gets the shard
    // dropped from the index entirely; a stale-but-complete table does not.
    // Trading "slightly stale" for "absent" is the #4583 mistake, inverted.
    const verdict = verify({
      storedGroups: [group({ refreshedAt: new Date(NOW.getTime() - 72 * 3_600_000) })],
    });
    expect(verdict.source).toBe('table');
    expect(verdict.warnings).toContain('stale');
    expect(verdict.ageHours).toBe(72);
  });

  it('escalates past two weeks, still without falling back', () => {
    const verdict = verify({
      storedGroups: [group({ refreshedAt: new Date(NOW.getTime() - 15 * 24 * 3_600_000) })],
    });
    expect(verdict.source).toBe('table');
    expect(verdict.warnings).toContain('severely-stale');
    expect(verdict.warnings).not.toContain('stale');
  });

  it('drops a stored group with no readable URL and serves the rest', () => {
    // Kilter layout 5 ("Spire") is this today: the job materialises it, web
    // cannot address it, so it leaves both the page arithmetic and the emitted
    // set — exactly as the live path drops it.
    const spire = group({ layoutId: 5, itemCount: 69 });
    const verdict = verify({
      storedGroups: [group(), spire],
      isResolvable: (candidate) => candidate.layoutId !== 5,
    });
    expect(verdict.source).toBe('table');
    expect(verdict.groups.map((row) => row.layoutId)).toEqual([1]);
    expect(verdict.warnings).toContain('unresolvable-group');
  });

  it('warns but still serves when web resolves a group the table has no rows for', () => {
    // The shape #4578 creates the moment it merges: seven MoonBoard groups web
    // can address and the table has not been rebuilt for. Those URLs are absent
    // until the next refresh; the rest of the shard is unaffected.
    const verdict = verify({
      storedGroups: [group()],
      resolvedGroups: [
        { boardType: 'kilter', layoutId: 1, sizeId: 27, setIds: [26, 31] },
        { boardType: 'moonboard', layoutId: 8, sizeId: 17, setIds: [24] },
      ],
    });
    expect(verdict.source).toBe('table');
    expect(verdict.warnings).toEqual(['missing-group']);
  });

  it('warns but still serves the STORED config when the winner flipped', () => {
    // The rows were selected under the stored config, and
    // `tryConstructSlugViewUrl` is the first branch of
    // `buildCanonicalClimbViewUrl`, so any resolvable config yields a URL
    // byte-identical to that page's own canonical. A ranking flip is cosmetic.
    const verdict = verify({
      storedGroups: [group()],
      resolvedGroups: [{ boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20] }],
    });
    expect(verdict.source).toBe('table');
    expect(verdict.warnings).toEqual(['config-drift']);
    expect(verdict.groups[0].sizeId).toBe(27);
  });

  it('serves cleanly when the table and the resolved winners agree', () => {
    const verdict = verify({
      storedGroups: [group()],
      resolvedGroups: [{ boardType: 'kilter', layoutId: 1, sizeId: 27, setIds: [26, 31] }],
    });
    expect(verdict).toMatchObject({ source: 'table', reason: 'ok', warnings: [] });
  });

  it('serves when the cross-check itself could not run', () => {
    // The cross-check is a detector, never a gate: GraphQL being down must not
    // move the sitemap onto the slow path.
    expect(verify({ storedGroups: [group()], resolvedGroups: null }).source).toBe('table');
  });
});

describe('planTier2Pages', () => {
  const groups = [
    group({ boardType: 'kilter', layoutId: 1, itemCount: 7 }),
    group({ boardType: 'kilter', layoutId: 8, itemCount: 9_998 }),
    group({ boardType: 'tension', layoutId: 9, itemCount: 5 }),
  ];

  /** `(layoutId, offset, limit)` — the literal triples, never a row count. */
  function triples(page: number) {
    return planTier2Pages(groups, page, 10_000).map((slice) => [slice.group.layoutId, slice.offset, slice.limit]);
  }

  it('spans the group boundary exactly', () => {
    // The only genuinely new arithmetic in #4583. An off-by-one drops or
    // duplicates exactly one URL per boundary — twelve URLs out of 126,500 with
    // thirteen pages, invisible to any count assertion. Hence the literal list.
    expect(triples(1)).toEqual([
      [1, 0, 7],
      [8, 0, 9_993],
    ]);
    expect(triples(2)).toEqual([
      [8, 9_993, 5],
      [9, 0, 5],
    ]);
  });

  it('returns nothing past the end', () => {
    expect(triples(3)).toEqual([]);
  });

  it('never asks for more than one page of rows', () => {
    const total = groups.reduce((sum, entry) => sum + entry.itemCount, 0);
    for (let page = 1; page <= Math.ceil(total / 10_000); page += 1) {
      const requested = planTier2Pages(groups, page, 10_000).reduce((sum, slice) => sum + slice.limit, 0);
      expect(requested).toBeLessThanOrEqual(10_000);
    }
  });

  it('covers every row exactly once across all pages', () => {
    // The property the literal assertions above are instances of: no URL is
    // dropped and none is submitted twice.
    const seen = new Map<number, number[]>();
    for (let page = 1; page <= 2; page += 1) {
      for (const slice of planTier2Pages(groups, page, 10_000)) {
        const covered = seen.get(slice.group.layoutId) ?? [];
        for (let index = slice.offset; index < slice.offset + slice.limit; index += 1) covered.push(index);
        seen.set(slice.group.layoutId, covered);
      }
    }
    for (const entry of groups) {
      expect(seen.get(entry.layoutId)).toEqual(Array.from({ length: entry.itemCount }, (_, index) => index));
    }
  });

  it('skips a group whose rows all fall on an earlier page', () => {
    const wide = [group({ layoutId: 1, itemCount: 25_000 }), group({ layoutId: 8, itemCount: 3 })];
    expect(planTier2Pages(wide, 3, 10_000).map((slice) => [slice.group.layoutId, slice.offset, slice.limit])).toEqual([
      [1, 20_000, 5_000],
      [8, 0, 3],
    ]);
  });
});
