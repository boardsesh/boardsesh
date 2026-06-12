import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSearchPath, getStatsDrivenSort, clampSearchPage, MAX_SEARCH_PAGE } from '../search-climbs';
import { mapSearchInputToParams, normalizeSearchSortBy } from '../types';

const baseInput = {
  statsDrivenSort: 'ascents' as const,
  isDraftsQuery: false,
  projectsOnly: false,
  routesOnly: false,
  page: 0,
  hasStatsFilters: false,
};

void describe('getStatsDrivenSort', () => {
  void it('returns ascents and quality only for descending stats-driven sorts', () => {
    assert.equal(getStatsDrivenSort('ascents', 'desc'), 'ascents');
    assert.equal(getStatsDrivenSort('quality', 'desc'), 'quality');
    assert.equal(getStatsDrivenSort('ascents', 'asc'), null);
    assert.equal(getStatsDrivenSort('quality', 'asc'), null);
    assert.equal(getStatsDrivenSort('creation', 'desc'), null);
  });
});

void describe('clampSearchPage', () => {
  void it('defaults undefined and non-finite input to 0', () => {
    assert.equal(clampSearchPage(undefined), 0);
    assert.equal(clampSearchPage(NaN), 0);
    assert.equal(clampSearchPage(Infinity), 0);
  });

  void it('floors negative pages to 0', () => {
    assert.equal(clampSearchPage(-1), 0);
    assert.equal(clampSearchPage(-9999), 0);
  });

  void it('passes through valid pages and truncates fractions', () => {
    assert.equal(clampSearchPage(0), 0);
    assert.equal(clampSearchPage(7), 7);
    assert.equal(clampSearchPage(3.9), 3);
  });

  void it('caps pages above MAX_SEARCH_PAGE to prevent deep-OFFSET abuse', () => {
    assert.equal(clampSearchPage(MAX_SEARCH_PAGE + 1), MAX_SEARCH_PAGE);
    assert.equal(clampSearchPage(10_000_000), MAX_SEARCH_PAGE);
  });
});

void describe('chooseSearchPath', () => {
  void describe('the hot path: ascents DESC, page 0, no stats filters', () => {
    void it('uses stats-driven-with-fallback so projects appear at the bottom of narrow-filter pages', () => {
      assert.equal(chooseSearchPath(baseInput), 'stats-driven-with-fallback');
    });
  });

  void describe('routes-only filter', () => {
    void it('uses standard-only so unclimbed routes (no stats row) still appear in the list', () => {
      assert.equal(chooseSearchPath({ ...baseInput, routesOnly: true }), 'standard-only');
    });
  });

  void describe('pages > 0', () => {
    void it('uses stats-driven-only on page 1 — fallback would re-create DSM pressure', () => {
      assert.equal(chooseSearchPath({ ...baseInput, page: 1 }), 'stats-driven-only');
    });

    void it('uses stats-driven-only on a deep page', () => {
      assert.equal(chooseSearchPath({ ...baseInput, page: 47 }), 'stats-driven-only');
    });
  });

  void describe('stats filters active (e.g. minAscents >= 1)', () => {
    void it('uses stats-driven-only on page 0 — stats-less climbs would be filtered out anyway', () => {
      assert.equal(chooseSearchPath({ ...baseInput, hasStatsFilters: true }), 'stats-driven-only');
    });

    void it('uses stats-driven-only on deeper pages with stats filters', () => {
      assert.equal(chooseSearchPath({ ...baseInput, page: 5, hasStatsFilters: true }), 'stats-driven-only');
    });
  });

  void describe('cases that bypass the stats-driven path entirely', () => {
    void it('uses standard-only when projectsOnly is set (user wants stats-less climbs)', () => {
      assert.equal(chooseSearchPath({ ...baseInput, projectsOnly: true }), 'standard-only');
    });

    void it('uses standard-only for drafts queries (drafts have no stats rows)', () => {
      assert.equal(chooseSearchPath({ ...baseInput, isDraftsQuery: true }), 'standard-only');
    });

    void it('uses standard-only for sorts without a stats-driven index path', () => {
      assert.equal(chooseSearchPath({ ...baseInput, statsDrivenSort: null }), 'standard-only');
    });

    void it('uses stats-driven-with-fallback for quality DESC page 0', () => {
      assert.equal(chooseSearchPath({ ...baseInput, statsDrivenSort: 'quality' }), 'stats-driven-with-fallback');
    });

    void it('uses stats-driven-only for quality DESC after page 0', () => {
      assert.equal(chooseSearchPath({ ...baseInput, statsDrivenSort: 'quality', page: 1 }), 'stats-driven-only');
    });
  });

  void describe('precedence', () => {
    void it('projectsOnly trumps the hot path', () => {
      assert.equal(
        chooseSearchPath({ ...baseInput, projectsOnly: true, page: 0, hasStatsFilters: false }),
        'standard-only',
      );
    });

    void it('drafts trumps the hot path', () => {
      assert.equal(chooseSearchPath({ ...baseInput, isDraftsQuery: true, page: 0 }), 'standard-only');
    });

    void it('non-ascents sort trumps page/filter conditions', () => {
      assert.equal(
        chooseSearchPath({
          ...baseInput,
          statsDrivenSort: null,
          page: 0,
          hasStatsFilters: false,
        }),
        'standard-only',
      );
    });
  });
});

void describe('normalizeSearchSortBy', () => {
  void it('keeps known search sort keys', () => {
    assert.equal(normalizeSearchSortBy('ascents'), 'ascents');
    assert.equal(normalizeSearchSortBy('quality'), 'quality');
    assert.equal(normalizeSearchSortBy('popular'), 'popular');
  });

  void it('maps legacy timestamp keys to creation sort', () => {
    assert.equal(normalizeSearchSortBy('created_at'), 'creation');
    assert.equal(normalizeSearchSortBy('published_at'), 'creation');
  });

  void it('uses ascents by default and explicit creation for unknown sort keys', () => {
    assert.equal(normalizeSearchSortBy(undefined), 'ascents');
    assert.equal(normalizeSearchSortBy(null), 'ascents');
    assert.equal(normalizeSearchSortBy('newest'), 'creation');
  });

  void it('normalizes sortBy while mapping raw search input', () => {
    assert.equal(mapSearchInputToParams({ sortBy: 'published_at' }).sortBy, 'creation');
    assert.equal(mapSearchInputToParams({ sortBy: 'unknown' }).sortBy, 'creation');
  });
});
