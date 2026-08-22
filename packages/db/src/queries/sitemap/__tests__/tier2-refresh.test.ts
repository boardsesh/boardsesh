import { describe, expect, it } from 'vite-plus/test';
import { MIN_EXPECTED_TIER2_ITEMS, planTier2Refresh } from '../tier2-refresh';
import { chooseWinningConfigPerLayout, type RankableBoardConfig } from '../tier2-groups';

describe('planTier2Refresh', () => {
  it('aborts a build that collapsed below the floor', () => {
    // The failure this guard exists for: a regressed predicate matching almost
    // nothing. Without it, one transaction swaps ~126,500 URLs for 400 and the
    // cron run stays green — the same silent-degrade class as the bug the table
    // fixes, only faster.
    expect(planTier2Refresh({ builtTotal: 400, previousTotal: 126_549 })).toEqual({
      action: 'abort',
      reason: 'below-floor',
    });
  });

  it('aborts a build that lost more than half the catalogue', () => {
    expect(planTier2Refresh({ builtTotal: 50_000, previousTotal: 126_549 })).toEqual({
      action: 'abort',
      reason: 'catastrophic-drop',
    });
  });

  it('commits a build that shrank within the guard', () => {
    expect(planTier2Refresh({ builtTotal: 120_000, previousTotal: 126_549 })).toEqual({ action: 'commit' });
  });

  it('commits the first run, which has no baseline to compare against', () => {
    // An absent baseline must not block the very run that creates it.
    expect(planTier2Refresh({ builtTotal: 53_000, previousTotal: null })).toEqual({ action: 'commit' });
  });

  it('still applies the absolute floor on a first run', () => {
    expect(planTier2Refresh({ builtTotal: 12, previousTotal: null })).toEqual({
      action: 'abort',
      reason: 'below-floor',
    });
  });

  it('has a floor under production and above any plausible regression', () => {
    // 53,262 items measured on production 2026-08-21 (Aurora only); ~126,500 once
    // MoonBoard's groups land. The floor must sit under the smaller of those.
    expect(MIN_EXPECTED_TIER2_ITEMS).toBeLessThan(53_262);
    expect(MIN_EXPECTED_TIER2_ITEMS).toBeGreaterThan(10_000);
  });
});

describe('chooseWinningConfigPerLayout', () => {
  function config(overrides: Partial<RankableBoardConfig> = {}): RankableBoardConfig {
    return {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 20],
      climbCount: 100,
      boardCount: 5,
      ...overrides,
    };
  }

  it('picks one config per layout, most boards first', () => {
    const groups = chooseWinningConfigPerLayout([
      config({ sizeId: 10, boardCount: 5 }),
      config({ sizeId: 27, boardCount: 40 }),
    ]);
    expect(groups).toEqual([{ boardType: 'kilter', layoutId: 1, sizeId: 27, setIds: [1, 20] }]);
  });

  it('is order-independent, so the emitted URL set does not churn between crawls', () => {
    const tied = [config({ sizeId: 27 }), config({ sizeId: 10 })];
    expect(chooseWinningConfigPerLayout(tied)[0].sizeId).toBe(10);
    expect(chooseWinningConfigPerLayout([...tied].reverse())[0].sizeId).toBe(10);
  });

  it('drops unknown board types and empty layouts', () => {
    expect(chooseWinningConfigPerLayout([config({ boardType: 'not-a-board' })])).toEqual([]);
    expect(chooseWinningConfigPerLayout([config({ climbCount: 0 })])).toEqual([]);
  });

  it('does NOT filter on URL resolvability', () => {
    // That rule is web's — it needs the locale-aware slug resolver, and the job
    // has no business owning a second copy of it. The refresh materialises every
    // winning group; the read path drops what it cannot address.
    expect(chooseWinningConfigPerLayout([config({ layoutId: 999_999 })])).toHaveLength(1);
  });
});
