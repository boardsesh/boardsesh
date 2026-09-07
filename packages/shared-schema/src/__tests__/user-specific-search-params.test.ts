import { describe, expect, it } from 'vitest';
import { USER_SPECIFIC_SEARCH_PARAMS } from '../types/climb';

// USER_SPECIFIC_SEARCH_PARAMS drives two things at once in the search resolver
// (packages/backend/src/graphql/resolvers/climbs/queries.ts): whether a userId
// is resolved at all, and whether the result may be written to the shared Redis
// entry. A filter missing from this list silently no-ops AND leaks a
// personalized result into everyone else's cache, with no type error to catch
// it — hence the explicit list assertion.
describe('USER_SPECIFIC_SEARCH_PARAMS', () => {
  it('lists every auth-gated search filter', () => {
    expect([...USER_SPECIFIC_SEARCH_PARAMS].sort()).toEqual(
      [
        'hideAttempted',
        'hideCompleted',
        'showOnlyAttempted',
        'showOnlyCompleted',
        'minUserRating',
        'onlyRatedByMe',
        'useMyGrades',
        'onlyDrafts',
      ].sort(),
    );
  });

  it('includes the personal rating filters (#2645)', () => {
    expect(USER_SPECIFIC_SEARCH_PARAMS).toContain('minUserRating');
    expect(USER_SPECIFIC_SEARCH_PARAMS).toContain('onlyRatedByMe');
  });

  // Without this entry the resolver never resolves a userId for a useMyGrades
  // search, so the personal-grade filter/sort has nobody to read ticks for and
  // quietly falls back to the crowd's grade — the row would then display one
  // grade and be filtered by another (#4828).
  it('includes the personal grade toggle (#4828)', () => {
    expect(USER_SPECIFIC_SEARCH_PARAMS).toContain('useMyGrades');
  });
});
