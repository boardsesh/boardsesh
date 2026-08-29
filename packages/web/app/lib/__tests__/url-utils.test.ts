import { describe, it, expect } from 'vite-plus/test';
import {
  searchParamsToUrlParams,
  parsedRouteSearchParamsToSearchParams,
  urlParamsToSearchParams,
  parseBoardRouteParams,
  constructClimbViewUrl,
  constructClimbViewUrlWithSlugs,
  constructClimbListWithSlugs,
  constructClimbInfoUrl,
  generateLayoutSlug,
  getMoonBoardLayoutBySlug,
  generateSizeSlug,
  generateSetSlug,
  generateSlugFromText,
  generateDescriptionSlug,
  extractUuidFromSlug,
  isUuidOnly,
  isNumericId,
  hasOnlyNumericBoardRouteSegments,
  layoutOwnsNumericSlugRedirect,
  getBaseBoardPath,
  extractAngleFromPathname,
  replaceAngleInPathname,
  getPlaylistsBasePath,
  getContextAwarePlaylistUrl,
  getContextAwareClimbViewUrl,
  constructBoardSlugViewUrl,
  constructBoardSlugPlaylistsUrl,
  tryConstructSlugViewUrl,
  buildCanonicalClimbListUrl,
  tryConstructSlugListUrl,
  popularConfigListUrl,
  DEFAULT_SEARCH_PARAMS,
} from '../url-utils';
import { resolveSizeSlugToId } from '@boardsesh/play-view/readable-url-utils';
import type { SearchRequestPagination, BoardDetails } from '../types';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

describe('searchParamsToUrlParams', () => {
  it('should return empty URLSearchParams when all values are defaults', () => {
    const result = searchParamsToUrlParams(DEFAULT_SEARCH_PARAMS);
    expect(result.toString()).toBe('');
  });

  it('should only include non-default values', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: 5,
    });

    expect(result.toString()).toBe('minGrade=5');
  });

  it('should handle multiple non-default values', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: 5,
      name: 'test climb',
      onlyBenchmarks: true,
    });

    const params = result.toString();
    expect(params).toContain('minGrade=5');
    expect(params).toContain('name=test+climb');
    expect(params).toContain('onlyBenchmarks=true');
  });

  it('should not include empty strings', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      name: '',
      settername: [],
      minGrade: 3,
    });

    expect(result.toString()).toBe('minGrade=3');
  });

  it('should include non-default sort values', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      sortBy: 'difficulty',
      sortOrder: 'asc',
    });

    const params = result.toString();
    expect(params).toContain('sortBy=difficulty');
    expect(params).toContain('sortOrder=asc');
  });

  it('round-trips the random sort seed through the URL', () => {
    const url = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      sortBy: 'random',
      sortSeed: '4242',
    });
    expect(url.toString()).toContain('sortBy=random');
    expect(url.toString()).toContain('sortSeed=4242');

    const parsed = urlParamsToSearchParams(url);
    expect(parsed.sortBy).toBe('random');
    expect(parsed.sortSeed).toBe('4242');
  });

  it('omits an empty sort seed from the URL and parses back to the default', () => {
    const url = searchParamsToUrlParams({ ...DEFAULT_SEARCH_PARAMS, sortSeed: '' });
    expect(url.toString()).not.toContain('sortSeed');
    expect(urlParamsToSearchParams(url).sortSeed).toBe('');
  });

  it('drops a non-numeric or oversized sort seed from a crafted URL', () => {
    // Digits-only, matching the backend zod contract; anything else → empty.
    expect(urlParamsToSearchParams(new URLSearchParams('sortSeed=abc')).sortSeed).toBe('');
    expect(urlParamsToSearchParams(new URLSearchParams('sortSeed=1;DROP')).sortSeed).toBe('');
    expect(urlParamsToSearchParams(new URLSearchParams(`sortSeed=${'9'.repeat(33)}`)).sortSeed).toBe('');
    expect(urlParamsToSearchParams(new URLSearchParams('sortSeed=42')).sortSeed).toBe('42');
  });

  it('should handle holds filter correctly', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: {
        142: { ANY: 'include' },
        205: { STARTING: 'exclude', FOOT: 'include' },
      },
    });

    expect(result.get('hold_142')).toBe('ANY:include');
    expect(result.get('hold_205')).toBe('STARTING:exclude,FOOT:include');
  });

  it('should not include holds filter when empty', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: {},
      minGrade: 2,
    });

    expect(result.toString()).toBe('minGrade=2');
  });

  it('should serialize any-hold zone mode only when a zone is set', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: { edgeLeft: 10, edgeRight: 80, edgeBottom: 20, edgeTop: 120 },
      zoneMode: 'anyHold',
    });

    expect(result.get('zoneMode')).toBe('anyHold');
    expect(result.get('zoneEdgeLeft')).toBe('10');
  });

  it('should omit default zone mode and mode values without a zone', () => {
    const defaultModeResult = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: { edgeLeft: 10, edgeRight: 80, edgeBottom: 20, edgeTop: 120 },
      zoneMode: 'allHolds',
    });
    expect(defaultModeResult.has('zoneMode')).toBe(false);

    const modeWithoutZoneResult = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      zoneMode: 'anyHold',
    });
    expect(modeWithoutZoneResult.has('zoneMode')).toBe(false);
  });

  it('should serialize wide climbs filter only when enabled', () => {
    const enabledResult = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      onlyWideClimbs: true,
    });
    expect(enabledResult.get('onlyWideClimbs')).toBe('true');

    const defaultResult = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      onlyWideClimbs: false,
    });
    expect(defaultResult.has('onlyWideClimbs')).toBe(false);
  });

  it('should serialize beta videos filter only when enabled', () => {
    const enabledResult = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      onlyWithBetaVideos: true,
    });
    expect(enabledResult.get('onlyWithBetaVideos')).toBe('true');

    const defaultResult = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      onlyWithBetaVideos: false,
    });
    expect(defaultResult.has('onlyWithBetaVideos')).toBe(false);
  });

  it('should handle page and pageSize correctly', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      page: 2,
      pageSize: 50,
    });

    const params = result.toString();
    expect(params).toContain('page=2');
    expect(params).toContain('pageSize=50');
  });

  it('should handle boolean values correctly', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      onlyBenchmarks: true,
    });

    expect(result.toString()).toBe('onlyBenchmarks=true');
  });

  it('should handle numeric zero values correctly', () => {
    // When the default is 0, setting it to 0 shouldn't be included
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: 0, // This is the default
      maxGrade: 5, // This is not the default
    });

    expect(result.toString()).toBe('maxGrade=5');
  });

  it('should treat undefined numeric fields as defaults without throwing', () => {
    // Regression: a recent-search pill tap on iOS Safari was crashing because
    // IndexedDB-persisted filters contained `undefined` for minGrade/maxGrade/
    // minAscents/minRating/gradeAccuracy, and the serializer called .toString()
    // on them. The boundary must coalesce undefined to the default.
    const corrupt = {
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: undefined,
      maxGrade: undefined,
      minAscents: undefined,
      minRating: undefined,
      gradeAccuracy: undefined,
    } as unknown as SearchRequestPagination;

    const result = searchParamsToUrlParams(corrupt);
    expect(result.toString()).toBe('');
  });

  it('should normalize decimal minRating values to whole-star thresholds', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      minRating: 2.5,
    });

    expect(result.get('minRating')).toBe('3');
  });

  it('should treat undefined non-numeric fields as defaults without throwing', () => {
    const corrupt = {
      ...DEFAULT_SEARCH_PARAMS,
      sortBy: undefined,
      sortOrder: undefined,
      name: undefined,
      onlyBenchmarks: undefined,
      onlyTallClimbs: undefined,
      onlyWideClimbs: undefined,
      settername: undefined,
      setternameSuggestion: undefined,
      holdsFilter: undefined,
      zoneMode: undefined,
      hideAttempted: undefined,
      hideCompleted: undefined,
      showOnlyAttempted: undefined,
      showOnlyCompleted: undefined,
      onlyDrafts: undefined,
      projectsOnly: undefined,
      page: undefined,
      pageSize: undefined,
    } as unknown as SearchRequestPagination;

    const result = searchParamsToUrlParams(corrupt);
    expect(result.toString()).toBe('');
  });

  it('should not throw when input itself is null or undefined', () => {
    // Defense in depth for #2067 — even if a future caller accidentally passes a
    // nullish value (e.g. uninitialised reducer state), the serializer should
    // fall back to defaults instead of crashing on `.toString()`.
    let resultFromUndefined!: URLSearchParams;
    expect(() => {
      resultFromUndefined = searchParamsToUrlParams(undefined as unknown as SearchRequestPagination);
    }).not.toThrow();
    expect(resultFromUndefined.toString()).toBe('');

    let resultFromNull!: URLSearchParams;
    expect(() => {
      resultFromNull = searchParamsToUrlParams(null as unknown as SearchRequestPagination);
    }).not.toThrow();
    expect(resultFromNull.toString()).toBe('');
  });

  it('should not throw when zoneBox has missing edge fields', () => {
    // Defense in depth: a corrupted zoneBox object with undefined edges should
    // not crash the serializer with `.toString()` on undefined. We omit the
    // whole zone filter rather than emitting partial params.
    const corruptZoneBox = {
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: { edgeLeft: undefined, edgeRight: undefined, edgeBottom: undefined, edgeTop: undefined },
    } as unknown as SearchRequestPagination;

    let result!: URLSearchParams;
    expect(() => {
      result = searchParamsToUrlParams(corruptZoneBox);
    }).not.toThrow();
    expect(result.has('zoneEdgeLeft')).toBe(false);
    expect(result.has('zoneEdgeRight')).toBe(false);
    expect(result.has('zoneEdgeBottom')).toBe(false);
    expect(result.has('zoneEdgeTop')).toBe(false);
  });

  describe('with a single undefined numeric field (legacy persisted state)', () => {
    const numericFields = [
      'gradeAccuracy',
      'maxGrade',
      'minGrade',
      'minAscents',
      'minRating',
      'page',
      'pageSize',
    ] as const;

    for (const field of numericFields) {
      it(`does not throw and omits the param when ${field} is undefined`, () => {
        const input = {
          ...DEFAULT_SEARCH_PARAMS,
          [field]: undefined as unknown as number,
        } as SearchRequestPagination;

        let result!: URLSearchParams;
        expect(() => {
          result = searchParamsToUrlParams(input);
        }).not.toThrow();
        expect(result.has(field)).toBe(false);
      });
    }
  });
});

describe('parsedRouteSearchParamsToSearchParams', () => {
  it('should convert string numbers to actual numbers', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: '5',
      maxGrade: '10',
      minAscents: '20',
      minRating: '3',
      gradeAccuracy: '1',
      page: '2',
      pageSize: '50',
    } as unknown as SearchRequestPagination;

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.minGrade).toBe(5);
    expect(result.maxGrade).toBe(10);
    expect(result.minAscents).toBe(20);
    expect(result.minRating).toBe(3);
    expect(result.gradeAccuracy).toBe(1);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(50);
    expect(typeof result.minGrade).toBe('number');
    expect(typeof result.maxGrade).toBe('number');
  });

  it('should normalize legacy decimal minRating route params upward', () => {
    const result = parsedRouteSearchParamsToSearchParams({
      ...DEFAULT_SEARCH_PARAMS,
      minRating: '2.5' as unknown as number,
    });

    expect(result.minRating).toBe(3);
  });

  it('should use defaults when values are undefined', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: undefined,
      maxGrade: undefined,
      name: 'test climb',
    } as unknown as SearchRequestPagination;

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.minGrade).toBe(DEFAULT_SEARCH_PARAMS.minGrade);
    expect(result.maxGrade).toBe(DEFAULT_SEARCH_PARAMS.maxGrade);
    expect(result.name).toBe('test climb');
  });

  it('should handle null values by using defaults', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: null as unknown as number,
      maxGrade: null as unknown as number,
      page: null as unknown as number,
    };

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.minGrade).toBe(DEFAULT_SEARCH_PARAMS.minGrade);
    expect(result.maxGrade).toBe(DEFAULT_SEARCH_PARAMS.maxGrade);
    expect(result.page).toBe(DEFAULT_SEARCH_PARAMS.page);
  });

  it('should handle empty string values by using defaults', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: '' as unknown as number,
      maxGrade: '' as unknown as number,
      minAscents: '' as unknown as number,
    };

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.minGrade).toBe(DEFAULT_SEARCH_PARAMS.minGrade);
    expect(result.maxGrade).toBe(DEFAULT_SEARCH_PARAMS.maxGrade);
    expect(result.minAscents).toBe(DEFAULT_SEARCH_PARAMS.minAscents);
  });

  it('should preserve non-numeric fields correctly', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      name: 'test climb',
      settername: ['john doe'],
      sortBy: 'difficulty' as SearchRequestPagination['sortBy'],
      sortOrder: 'asc' as SearchRequestPagination['sortOrder'],
      onlyBenchmarks: true,
      holdsFilter: { 142: { ANY: 'include' as const } },
      zoneEdgeLeft: '10',
      zoneEdgeRight: '80',
      zoneEdgeBottom: '20',
      zoneEdgeTop: '120',
      zoneMode: 'anyHold' as const,
    };

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.name).toBe('test climb');
    expect(result.settername).toEqual(['john doe']);
    expect(result.sortBy).toBe('difficulty');
    expect(result.sortOrder).toBe('asc');
    expect(result.onlyBenchmarks).toBe(true);
    expect(result.holdsFilter).toEqual({ 142: { ANY: 'include' } });
    expect(result.zoneBox).toEqual({ edgeLeft: 10, edgeRight: 80, edgeBottom: 20, edgeTop: 120 });
    expect(result.zoneMode).toBe('anyHold');
  });

  it('should default SSR zone mode when the route record omits it', () => {
    const input = {
      zoneEdgeLeft: '10',
      zoneEdgeRight: '80',
      zoneEdgeBottom: '20',
      zoneEdgeTop: '120',
    } as unknown as SearchRequestPagination;

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.zoneBox).toEqual({ edgeLeft: 10, edgeRight: 80, edgeBottom: 20, edgeTop: 120 });
    expect(result.zoneMode).toBe(DEFAULT_SEARCH_PARAMS.zoneMode);
  });

  it('should parse wide climbs filter from SSR route params', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      onlyWideClimbs: 'true' as unknown as boolean,
    };

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.onlyWideClimbs).toBe(true);
  });

  it('should handle mixed string and number inputs', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: '5' as unknown as number,
      maxGrade: 10, // already a number
      name: 'test',
      page: '1' as unknown as number,
      pageSize: 25, // already a number
    };

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.minGrade).toBe(5);
    expect(result.maxGrade).toBe(10);
    expect(result.name).toBe('test');
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    expect(typeof result.minGrade).toBe('number');
    expect(typeof result.maxGrade).toBe('number');
    expect(typeof result.page).toBe('number');
    expect(typeof result.pageSize).toBe('number');
  });

  it('should handle invalid number strings by falling back to defaults', () => {
    const input = {
      ...DEFAULT_SEARCH_PARAMS,
      minGrade: 'invalid' as unknown as number,
      maxGrade: 'NaN' as unknown as number,
      page: 'not-a-number' as unknown as number,
    };

    const result = parsedRouteSearchParamsToSearchParams(input);

    // Number('invalid') returns NaN, Number(NaN ?? default) should use default
    expect(isNaN(result.minGrade)).toBe(true); // This might be NaN, which could cause 404s
    expect(isNaN(result.maxGrade)).toBe(true);
    expect(isNaN(result.page)).toBe(true);
  });

  it('should return all default values when input only contains defaults', () => {
    const result = parsedRouteSearchParamsToSearchParams(DEFAULT_SEARCH_PARAMS);

    expect(result).toEqual(DEFAULT_SEARCH_PARAMS);
    expect(typeof result.minGrade).toBe('number');
    expect(typeof result.maxGrade).toBe('number');
    expect(typeof result.page).toBe('number');
  });
});

describe('urlParamsToSearchParams', () => {
  it('should convert URLSearchParams to SearchRequestPagination', () => {
    const urlParams = new URLSearchParams({
      minGrade: '5',
      maxGrade: '10',
      name: 'test climb',
      onlyBenchmarks: 'true',
      page: '2',
      hold_142: 'ANY:include',
      hold_205: 'STARTING:exclude,FOOT:include',
    });

    const result = urlParamsToSearchParams(urlParams);

    expect(result.minGrade).toBe(5);
    expect(result.maxGrade).toBe(10);
    expect(result.name).toBe('test climb');
    expect(result.onlyBenchmarks).toBe(true);
    expect(result.page).toBe(2);
    expect(result.holdsFilter).toEqual({
      142: { ANY: 'include' },
      205: { STARTING: 'exclude', FOOT: 'include' },
    });
  });

  it('should normalize legacy decimal minRating URL params upward', () => {
    const result = urlParamsToSearchParams(new URLSearchParams({ minRating: '2.5' }));
    expect(result.minRating).toBe(3);
  });

  it('should accept legacy single-value hold params for backward compat', () => {
    // Pre-#1841 URLs encoded each hold as a single state. The shim must keep
    // these working so shared/bookmarked links don't silently drop filters.
    const urlParams = new URLSearchParams({
      hold_142: 'STARTING',
      hold_205: 'NOT',
      hold_300: 'ANY',
    });

    const result = urlParamsToSearchParams(urlParams);

    expect(result.holdsFilter).toEqual({
      142: { STARTING: 'include' },
      205: { ANY: 'exclude' },
      300: { ANY: 'include' },
    });
  });

  it('should drop hold params with non-numeric IDs', () => {
    const urlParams = new URLSearchParams({
      hold_red: 'ANY:include',
      'hold_-1': 'ANY:include',
      'hold_1.5': 'ANY:include',
      hold_: 'ANY:include',
      hold_142: 'ANY:include',
    });

    const result = urlParamsToSearchParams(urlParams);

    expect(result.holdsFilter).toEqual({ 142: { ANY: 'include' } });
  });

  // Woods numbers its holds from 0, so hold 0 is a real hold and has to survive
  // the parse — boardsesh/boardsesh#4748.
  it('should keep hold id 0', () => {
    const urlParams = new URLSearchParams({ hold_0: 'ANY:include' });

    const result = urlParamsToSearchParams(urlParams);

    expect(result.holdsFilter).toEqual({ 0: { ANY: 'include' } });
  });

  it('should use defaults for missing parameters', () => {
    const urlParams = new URLSearchParams({ name: 'test' });
    const result = urlParamsToSearchParams(urlParams);

    expect(result.minGrade).toBe(DEFAULT_SEARCH_PARAMS.minGrade);
    expect(result.maxGrade).toBe(DEFAULT_SEARCH_PARAMS.maxGrade);
    expect(result.name).toBe('test');
    expect(result.sortBy).toBe(DEFAULT_SEARCH_PARAMS.sortBy);
    expect(result.onlyWideClimbs).toBe(DEFAULT_SEARCH_PARAMS.onlyWideClimbs);
    expect(result.zoneMode).toBe(DEFAULT_SEARCH_PARAMS.zoneMode);
  });

  it('should parse wide climbs filter from URL params', () => {
    const result = urlParamsToSearchParams(new URLSearchParams({ onlyWideClimbs: 'true' }));

    expect(result.onlyWideClimbs).toBe(true);
  });

  it('should parse beta videos filter from URL params', () => {
    const result = urlParamsToSearchParams(new URLSearchParams({ onlyWithBetaVideos: 'true' }));

    expect(result.onlyWithBetaVideos).toBe(true);
  });

  it('should parse any-hold zone mode only with a valid zone', () => {
    const urlParams = new URLSearchParams({
      zoneEdgeLeft: '10',
      zoneEdgeRight: '80',
      zoneEdgeBottom: '20',
      zoneEdgeTop: '120',
      zoneMode: 'anyHold',
    });

    const result = urlParamsToSearchParams(urlParams);

    expect(result.zoneBox).toEqual({ edgeLeft: 10, edgeRight: 80, edgeBottom: 20, edgeTop: 120 });
    expect(result.zoneMode).toBe('anyHold');
  });

  it('should default invalid or orphaned zone modes to all-holds', () => {
    const invalidMode = urlParamsToSearchParams(
      new URLSearchParams({
        zoneEdgeLeft: '10',
        zoneEdgeRight: '80',
        zoneEdgeBottom: '20',
        zoneEdgeTop: '120',
        zoneMode: 'nearby',
      }),
    );
    expect(invalidMode.zoneMode).toBe('allHolds');

    const orphanedMode = urlParamsToSearchParams(new URLSearchParams({ zoneMode: 'anyHold' }));
    expect(orphanedMode.zoneBox).toBeNull();
    expect(orphanedMode.zoneMode).toBe('allHolds');
  });

  it('should handle empty URLSearchParams', () => {
    const urlParams = new URLSearchParams();
    const result = urlParamsToSearchParams(urlParams);

    expect(result).toEqual(DEFAULT_SEARCH_PARAMS);
  });
});

describe('parseBoardRouteParams', () => {
  it('should parse board route parameters correctly', () => {
    const params = {
      board_name: 'kilter',
      layout_id: '5',
      size_id: '10',
      set_ids: '1%2C2%2C3', // encoded "1,2,3"
      angle: '45',
    };

    const result = parseBoardRouteParams(params);

    expect(result.board_name).toBe('kilter');
    expect(result.layout_id).toBe(5);
    expect(result.size_id).toBe(10);
    expect(result.set_ids).toEqual([1, 2, 3]);
    expect(result.angle).toBe(45);
  });

  it('should handle climb_uuid when present', () => {
    const params = {
      board_name: 'tension',
      layout_id: '1',
      size_id: '2',
      set_ids: '4%2C5',
      angle: '30',
      climb_uuid: 'abc123def456',
    };

    const result = parseBoardRouteParams(params);

    expect(result.climb_uuid).toBe('abc123def456');
    expect(result.board_name).toBe('tension');
  });
});

describe('URL construction functions', () => {
  const mockRouteParams = {
    board_name: 'kilter' as const,
    layout_id: 1,
    size_id: 2,
    set_ids: [3, 4],
    angle: 45,
  };

  describe('constructClimbViewUrl', () => {
    it('should construct URL with climb name slug', () => {
      const result = constructClimbViewUrl(mockRouteParams, 'abc123', 'Test Climb Name');
      expect(result).toBe('/kilter/1/2/3,4/45/view/test-climb-name-abc123');
    });

    it('should construct URL without climb name', () => {
      const result = constructClimbViewUrl(mockRouteParams, 'abc123');
      expect(result).toBe('/kilter/1/2/3,4/45/view/abc123');
    });

    it('should handle empty climb name', () => {
      const result = constructClimbViewUrl(mockRouteParams, 'abc123', '');
      expect(result).toBe('/kilter/1/2/3,4/45/view/abc123');
    });
  });

  describe('constructClimbInfoUrl', () => {
    it('should return null for kilter (app URL no longer accessible)', () => {
      const boardDetails = { board_name: 'kilter' as const };
      const result = constructClimbInfoUrl(boardDetails as unknown as BoardDetails, 'abc123');
      expect(result).toBeNull();
    });

    it('should construct external info URL for tension', () => {
      const boardDetails = { board_name: 'tension' as const };
      const result = constructClimbInfoUrl(boardDetails as unknown as BoardDetails, 'def456');
      expect(result).toBe('https://tensionboardapp2.com/climbs/def456');
    });
  });
});

describe('Slug generation functions', () => {
  describe('generateLayoutSlug', () => {
    it('should remove board name prefix', () => {
      expect(generateLayoutSlug('Kilter Board Layout')).toBe('layout');
      expect(generateLayoutSlug('Tension Board Original Layout')).toBe('original');
    });

    it('should handle tension specific cases', () => {
      expect(generateLayoutSlug('Original Layout')).toBe('original');
      expect(generateLayoutSlug('2-Zone Layout')).toBe('two-zone-layout');
    });

    it('should preserve numeric-only layout slugs when the name is just a year', () => {
      expect(generateLayoutSlug('Grasshopper 2020')).toBe('2020');
    });
  });

  describe('getMoonBoardLayoutBySlug', () => {
    // Regression coverage for the MoonBoard 404 bug: the generator strips the
    // "moonboard" prefix from layout names, so the parser must accept slugs
    // like "2016" and "masters-2017" — not just the MOONBOARD_LAYOUTS keys.
    const cases: Array<{ name: string; expectedSlug: string; expectedId: number }> = [
      { name: 'MoonBoard 2010', expectedSlug: '2010', expectedId: 1 },
      { name: 'MoonBoard 2016', expectedSlug: '2016', expectedId: 2 },
      { name: 'MoonBoard 2024', expectedSlug: '2024', expectedId: 3 },
      { name: 'MoonBoard Masters 2017', expectedSlug: 'masters-2017', expectedId: 4 },
      { name: 'MoonBoard Masters 2019', expectedSlug: 'masters-2019', expectedId: 5 },
      { name: 'Mini MoonBoard 2020', expectedSlug: 'mini-moonboard-2020', expectedId: 6 },
    ];

    it.each(cases)('round-trips $name through generateLayoutSlug', ({ name, expectedSlug, expectedId }) => {
      const slug = generateLayoutSlug(name);
      expect(slug).toBe(expectedSlug);
      const resolved = getMoonBoardLayoutBySlug(slug);
      expect(resolved).toEqual({ id: expectedId, name });
    });

    it('still accepts legacy MOONBOARD_LAYOUTS keys for backwards compatibility', () => {
      expect(getMoonBoardLayoutBySlug('moonboard-2016')).toEqual({ id: 2, name: 'MoonBoard 2016' });
      expect(getMoonBoardLayoutBySlug('moonboard-masters-2017')).toEqual({
        id: 4,
        name: 'MoonBoard Masters 2017',
      });
    });

    it('returns null for unknown slugs', () => {
      expect(getMoonBoardLayoutBySlug('not-a-layout')).toBeNull();
      expect(getMoonBoardLayoutBySlug('')).toBeNull();
    });
  });

  describe('generateSizeSlug', () => {
    it('should extract dimensions from size name', () => {
      expect(generateSizeSlug('12 x 12 Commercial')).toBe('12x12');
      expect(generateSizeSlug('8 X 10 Home')).toBe('8x10');
    });

    it('should fallback to general slug for non-dimensional names', () => {
      expect(generateSizeSlug('Custom Size')).toBe('custom-size');
    });

    describe('with description parameter (for disambiguating sizes)', () => {
      it('should append description suffix for Full Ride LED Kit', () => {
        expect(generateSizeSlug('10x12', 'Full Ride LED Kit')).toBe('10x12-full-ride');
      });

      it('should append description suffix for Mainline LED Kit', () => {
        expect(generateSizeSlug('10x12', 'Mainline LED Kit')).toBe('10x12-mainline');
      });

      it('should handle size with spaces in name', () => {
        expect(generateSizeSlug('10 x 12', 'Full Ride LED Kit')).toBe('10x12-full-ride');
      });

      it('should return just dimensions when description is empty', () => {
        expect(generateSizeSlug('10x12', '')).toBe('10x12');
        expect(generateSizeSlug('10x12', '   ')).toBe('10x12');
      });

      it('should return just dimensions when description is undefined', () => {
        expect(generateSizeSlug('10x12', undefined)).toBe('10x12');
        expect(generateSizeSlug('10x12')).toBe('10x12');
      });

      it('should handle description with only LED Kit (no meaningful suffix)', () => {
        // After removing "LED Kit", if nothing remains, just return dimensions
        expect(generateSizeSlug('10x12', 'LED Kit')).toBe('10x12');
      });

      it('should handle various LED Kit formats', () => {
        expect(generateSizeSlug('10x12', 'Full Ride led kit')).toBe('10x12-full-ride');
        expect(generateSizeSlug('10x12', 'Full Ride LED KIT')).toBe('10x12-full-ride');
        expect(generateSizeSlug('10x12', 'Full RideLEDKit')).toBe('10x12-full-ride');
      });

      it('should handle non-dimensional size names with description', () => {
        expect(generateSizeSlug('Custom Size', 'Full Ride LED Kit')).toBe('custom-size-full-ride');
      });
    });
  });

  describe('generateSetSlug', () => {
    describe('homewall specific sets - full names', () => {
      it('should handle Auxiliary Kickboard', () => {
        expect(generateSetSlug(['Auxiliary Kickboard'])).toBe('aux-kicker');
      });

      it('should handle Mainline Kickboard', () => {
        expect(generateSetSlug(['Mainline Kickboard'])).toBe('main-kicker');
      });

      it('should handle Auxiliary (standalone)', () => {
        expect(generateSetSlug(['Auxiliary'])).toBe('aux');
      });

      it('should handle Mainline (standalone)', () => {
        expect(generateSetSlug(['Mainline'])).toBe('main');
      });
    });

    describe('homewall specific sets - abbreviated names (Aux/Main)', () => {
      it('should handle Aux Kickboard', () => {
        expect(generateSetSlug(['Aux Kickboard'])).toBe('aux-kicker');
      });

      it('should handle Main Kickboard', () => {
        expect(generateSetSlug(['Main Kickboard'])).toBe('main-kicker');
      });

      it('should handle Aux (standalone)', () => {
        expect(generateSetSlug(['Aux'])).toBe('aux');
      });

      it('should handle Main (standalone)', () => {
        expect(generateSetSlug(['Main'])).toBe('main');
      });
    });

    describe('homewall specific sets - case insensitivity', () => {
      it('should handle lowercase auxiliary kickboard', () => {
        expect(generateSetSlug(['auxiliary kickboard'])).toBe('aux-kicker');
      });

      it('should handle uppercase AUXILIARY KICKBOARD', () => {
        expect(generateSetSlug(['AUXILIARY KICKBOARD'])).toBe('aux-kicker');
      });

      it('should handle mixed case AuXiLiArY', () => {
        expect(generateSetSlug(['AuXiLiArY'])).toBe('aux');
      });

      it('should handle lowercase aux', () => {
        expect(generateSetSlug(['aux'])).toBe('aux');
      });

      it('should handle uppercase AUX', () => {
        expect(generateSetSlug(['AUX'])).toBe('aux');
      });
    });

    describe('homewall specific sets - with extra whitespace', () => {
      it('should handle leading/trailing whitespace', () => {
        expect(generateSetSlug(['  Auxiliary Kickboard  '])).toBe('aux-kicker');
        expect(generateSetSlug(['  Auxiliary  '])).toBe('aux');
      });
    });

    describe('homewall specific sets - "kicker" naming variant (used in some sizes like 10x12)', () => {
      it('should handle Aux Kicker (without "board")', () => {
        expect(generateSetSlug(['Aux Kicker'])).toBe('aux-kicker');
      });

      it('should handle Main Kicker (without "board")', () => {
        expect(generateSetSlug(['Main Kicker'])).toBe('main-kicker');
      });

      it('should handle Auxiliary Kicker', () => {
        expect(generateSetSlug(['Auxiliary Kicker'])).toBe('aux-kicker');
      });

      it('should handle Mainline Kicker', () => {
        expect(generateSetSlug(['Mainline Kicker'])).toBe('main-kicker');
      });

      it('should generate correct slug for 10x12 with kicker naming', () => {
        const result = generateSetSlug(['Aux Kicker', 'Main Kicker', 'Aux', 'Main']);
        expect(result).toBe('main-kicker_main_aux-kicker_aux');
      });
    });

    describe('homewall full ride - all four sets combined', () => {
      it('should generate correct slug for all four homewall sets (full names)', () => {
        const result = generateSetSlug(['Auxiliary Kickboard', 'Mainline Kickboard', 'Auxiliary', 'Mainline']);
        // Should be sorted alphabetically descending and joined with underscores
        expect(result).toBe('main-kicker_main_aux-kicker_aux');
      });

      it('should generate correct slug for all four homewall sets (abbreviated names)', () => {
        const result = generateSetSlug(['Aux Kickboard', 'Main Kickboard', 'Aux', 'Main']);
        expect(result).toBe('main-kicker_main_aux-kicker_aux');
      });

      it('should generate correct slug for mixed full and abbreviated names', () => {
        const result = generateSetSlug(['Auxiliary Kickboard', 'Main Kickboard', 'Aux', 'Mainline']);
        expect(result).toBe('main-kicker_main_aux-kicker_aux');
      });
    });

    describe('homewall partial selections', () => {
      it('should handle aux + main (no kickers)', () => {
        const result = generateSetSlug(['Auxiliary', 'Mainline']);
        expect(result).toBe('main_aux');
      });

      it('should handle aux-kicker + main-kicker (kickers only)', () => {
        const result = generateSetSlug(['Auxiliary Kickboard', 'Mainline Kickboard']);
        expect(result).toBe('main-kicker_aux-kicker');
      });

      it('should handle aux + aux-kicker (aux variants only)', () => {
        const result = generateSetSlug(['Auxiliary', 'Auxiliary Kickboard']);
        expect(result).toBe('aux-kicker_aux');
      });

      it('should handle main + main-kicker (main variants only)', () => {
        const result = generateSetSlug(['Mainline', 'Mainline Kickboard']);
        expect(result).toBe('main-kicker_main');
      });

      it('should handle single aux selection', () => {
        expect(generateSetSlug(['Auxiliary'])).toBe('aux');
        expect(generateSetSlug(['Aux'])).toBe('aux');
      });

      it('should handle aux + main-kicker + main (no aux-kicker)', () => {
        const result = generateSetSlug(['Auxiliary', 'Mainline Kickboard', 'Mainline']);
        expect(result).toBe('main-kicker_main_aux');
      });
    });

    describe('original kilter/tension sets', () => {
      it('should handle Bolt Ons', () => {
        expect(generateSetSlug(['Bolt Ons'])).toBe('bolt');
      });

      it('should handle Screw Ons', () => {
        expect(generateSetSlug(['Screw Ons'])).toBe('screw');
      });

      it('should handle bolt on (singular)', () => {
        expect(generateSetSlug(['Bolt On'])).toBe('bolt');
      });

      it('should handle screw on (singular)', () => {
        expect(generateSetSlug(['Screw On'])).toBe('screw');
      });

      it('should sort bolt and screw correctly', () => {
        const result = generateSetSlug(['Bolt Ons', 'Screw Ons']);
        expect(result).toBe('screw_bolt');
      });
    });

    describe('sorting behavior', () => {
      it('should sort slugs alphabetically descending', () => {
        // z > a, so 'screw' > 'main' > 'bolt' > 'aux'
        const result = generateSetSlug(['Auxiliary', 'Bolt Ons', 'Mainline', 'Screw Ons']);
        expect(result).toBe('screw_main_bolt_aux');
      });

      it('should maintain consistent ordering regardless of input order', () => {
        const order1 = generateSetSlug(['Auxiliary', 'Mainline', 'Auxiliary Kickboard', 'Mainline Kickboard']);
        const order2 = generateSetSlug(['Mainline Kickboard', 'Auxiliary Kickboard', 'Mainline', 'Auxiliary']);
        const order3 = generateSetSlug(['Auxiliary Kickboard', 'Auxiliary', 'Mainline Kickboard', 'Mainline']);

        expect(order1).toBe(order2);
        expect(order2).toBe(order3);
        expect(order1).toBe('main-kicker_main_aux-kicker_aux');
      });
    });

    describe('edge cases', () => {
      it('should handle empty array', () => {
        expect(generateSetSlug([])).toBe('');
      });

      it('should handle single set', () => {
        expect(generateSetSlug(['Auxiliary'])).toBe('aux');
      });

      it('should handle sets with numbers', () => {
        // Generic set names should fall through to general slug generation
        expect(generateSetSlug(['Set 1'])).toBe('set-1');
      });

      it('should handle sets with special characters', () => {
        expect(generateSetSlug(['Test Set!'])).toBe('test-set!');
      });
    });
  });
});

describe('Utility functions', () => {
  describe('extractUuidFromSlug', () => {
    it('should extract UUID from slug with UUID at end', () => {
      expect(extractUuidFromSlug('test-climb-ABCDEF1234567890ABCDEF1234567890')).toBe(
        'ABCDEF1234567890ABCDEF1234567890',
      );
    });

    it('should return UUID if input is already just UUID', () => {
      expect(extractUuidFromSlug('ABCDEF1234567890ABCDEF1234567890')).toBe('ABCDEF1234567890ABCDEF1234567890');
    });

    it('should return input if no UUID found', () => {
      expect(extractUuidFromSlug('no-uuid-here')).toBe('no-uuid-here');
    });
  });

  describe('isUuidOnly', () => {
    it('should return true for 32-character hex string', () => {
      expect(isUuidOnly('ABCDEF1234567890ABCDEF1234567890')).toBe(true);
      expect(isUuidOnly('abcdef1234567890abcdef1234567890')).toBe(true);
    });

    it('should return false for non-UUID strings', () => {
      expect(isUuidOnly('test-climb-name')).toBe(false);
      expect(isUuidOnly('ABC123')).toBe(false);
      expect(isUuidOnly('')).toBe(false);
    });

    it('stays false for a dashed MoonBoard uuid, on purpose', () => {
      // `extractUuidFromSlug` DOES understand the dashed form, so it is tempting
      // to widen this too. Do not: the only caller that gains anything is the
      // slug-redirect branch in `/[board_name]/…/view/[climb_uuid]`, which
      // resolves its layout through `getLayouts(board_name)` — the Aurora
      // `board-constants` tables, which carry no MoonBoard rows at all
      // (`getAllLayouts('moonboard')` is `[]`). Returning true here sends every
      // bare-uuid MoonBoard climb URL into that branch, where `layout` is
      // undefined and the page calls `notFound()`. Today those URLs render and
      // carry a canonical pointing at their slug form, which is the consolidation
      // Google needs; a 308 would cost a working page to gain nothing.
      expect(isUuidOnly('9fe54099-6fdd-5adb-b82f-2d7bcb10d4ad')).toBe(false);
    });
  });

  describe('isNumericId', () => {
    it('should return true for numeric strings', () => {
      expect(isNumericId('123')).toBe(true);
      expect(isNumericId('0')).toBe(true);
    });

    it('should return false for non-numeric strings', () => {
      expect(isNumericId('abc')).toBe(false);
      expect(isNumericId('12x12')).toBe(false);
      expect(isNumericId('')).toBe(false);
    });
  });

  describe('hasOnlyNumericBoardRouteSegments', () => {
    it('should return true for legacy numeric board routes', () => {
      expect(
        hasOnlyNumericBoardRouteSegments({
          layout_id: '8',
          size_id: '25',
          set_ids: '26,27,28,29',
        }),
      ).toBe(true);
    });

    it('should treat encoded numeric set ids as numeric', () => {
      expect(
        hasOnlyNumericBoardRouteSegments({
          layout_id: '8',
          size_id: '25',
          set_ids: '26%2C27%2C28%2C29',
        }),
      ).toBe(true);
    });

    it('should return false for grasshopper slug routes with a numeric-looking layout slug', () => {
      expect(
        hasOnlyNumericBoardRouteSegments({
          layout_id: '2020',
          size_id: 'grandmaster-12-x-12',
          set_ids: 'power_flow_engage',
        }),
      ).toBe(false);
    });
  });

  describe('layoutOwnsNumericSlugRedirect', () => {
    it('owns the redirect for a bare list URL', () => {
      expect(layoutOwnsNumericSlugRedirect('/kilter/1/10/1,20/40/list')).toBe(true);
    });

    it('owns the redirect for non-climb child routes (create/liked/logbook)', () => {
      expect(layoutOwnsNumericSlugRedirect('/kilter/1/10/1,20/40/create')).toBe(true);
      expect(layoutOwnsNumericSlugRedirect('/kilter/1/10/1,20/40/liked')).toBe(true);
      expect(layoutOwnsNumericSlugRedirect('/kilter/1/10/1,20/40/logbook')).toBe(true);
    });

    it('defers to the child page for a numeric view URL (the fix: keep the climb)', () => {
      expect(layoutOwnsNumericSlugRedirect('/kilter/1/10/1,20/40/view/abcdef1234567890abcdef1234567890')).toBe(false);
    });

    it('defers to the child page for a numeric play URL', () => {
      expect(layoutOwnsNumericSlugRedirect('/kilter/1/10/1,20/40/play/abcdef1234567890abcdef1234567890')).toBe(false);
    });
  });
});

describe('getBaseBoardPath', () => {
  describe('stripping /play/[uuid] segments', () => {
    it('should strip /play/[uuid] from path with angle', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45/play/abc-123')).toBe('/kilter/original/12x12/default');
    });

    it('should strip /play/[slug-uuid] from path', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45/play/test-climb-name-abc123def456')).toBe(
        '/kilter/original/12x12/default',
      );
    });

    it('should handle different angles', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/50/play/abc-123')).toBe('/kilter/original/12x12/default');
      expect(getBaseBoardPath('/tension/original/8x10/bolt/30/play/xyz-789')).toBe('/tension/original/8x10/bolt');
    });
  });

  describe('stripping /view/[uuid] segments', () => {
    it('should strip /view/[uuid] from path', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45/view/abc123')).toBe('/kilter/original/12x12/default');
    });

    it('should strip /view/[slug-uuid] from path', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45/view/test-climb-abc123def456')).toBe(
        '/kilter/original/12x12/default',
      );
    });
  });

  describe('stripping /list segment', () => {
    it('should strip /list from path with angle', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45/list')).toBe('/kilter/original/12x12/default');
    });

    it('should handle different board configurations', () => {
      expect(getBaseBoardPath('/tension/two-zone/10x12/main_aux/40/list')).toBe('/tension/two-zone/10x12/main_aux');
    });
  });

  describe('stripping /create segment', () => {
    it('should strip /create from path with angle', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45/create')).toBe('/kilter/original/12x12/default');
    });
  });

  describe('stripping angle from base path', () => {
    it('should strip angle from path without view segment', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45')).toBe('/kilter/original/12x12/default');
    });

    it('should strip different angle values', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/0')).toBe('/kilter/original/12x12/default');
      expect(getBaseBoardPath('/kilter/original/12x12/default/70')).toBe('/kilter/original/12x12/default');
    });
  });

  describe('edge cases', () => {
    it('should return path as-is if no matching segments', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default')).toBe('/kilter/original/12x12/default');
    });

    it('should handle paths with complex set slugs', () => {
      expect(getBaseBoardPath('/kilter/homewall/10x12-full-ride/main-kicker_main_aux-kicker_aux/45/play/abc-123')).toBe(
        '/kilter/homewall/10x12-full-ride/main-kicker_main_aux-kicker_aux',
      );
    });

    it('should handle tension board paths', () => {
      expect(getBaseBoardPath('/tension/original/8x10/screw_bolt/35/list')).toBe('/tension/original/8x10/screw_bolt');
    });

    it('should handle empty string', () => {
      expect(getBaseBoardPath('')).toBe('');
    });

    it('should handle root path', () => {
      expect(getBaseBoardPath('/')).toBe('/');
    });

    it('should not strip segments that look like angle but are part of set names', () => {
      // Sets like "main_aux" should not have digits stripped
      // This is handled correctly because we only strip the last segment if it's purely numeric
      expect(getBaseBoardPath('/kilter/original/12x12/main_aux')).toBe('/kilter/original/12x12/main_aux');
    });
  });

  describe('session continuity scenarios', () => {
    it('should return same base path for same board with different climbs', () => {
      const path1 = getBaseBoardPath('/kilter/original/12x12/default/45/play/climb-uuid-1');
      const path2 = getBaseBoardPath('/kilter/original/12x12/default/45/play/climb-uuid-2');
      expect(path1).toBe(path2);
    });

    it('should return same base path for same board with different angles', () => {
      const path1 = getBaseBoardPath('/kilter/original/12x12/default/45/list');
      const path2 = getBaseBoardPath('/kilter/original/12x12/default/50/list');
      expect(path1).toBe(path2);
    });

    it('should return same base path for same board with different views', () => {
      const path1 = getBaseBoardPath('/kilter/original/12x12/default/45/list');
      const path2 = getBaseBoardPath('/kilter/original/12x12/default/45/play/abc-123');
      const path3 = getBaseBoardPath('/kilter/original/12x12/default/45/create');
      expect(path1).toBe(path2);
      expect(path2).toBe(path3);
    });

    it('should return different base paths for different board configurations', () => {
      const path1 = getBaseBoardPath('/kilter/original/12x12/default/45/list');
      const path2 = getBaseBoardPath('/kilter/homewall/10x12/main_aux/45/list');
      expect(path1).not.toBe(path2);
    });
  });
});

describe('Shared slug helper functions', () => {
  describe('generateSlugFromText', () => {
    it('should convert text to lowercase', () => {
      expect(generateSlugFromText('Full Wall')).toBe('full-wall');
      expect(generateSlugFromText('UPPERCASE')).toBe('uppercase');
    });

    it('should replace spaces with hyphens', () => {
      expect(generateSlugFromText('multiple words here')).toBe('multiple-words-here');
    });

    it('should remove special characters', () => {
      expect(generateSlugFromText('Hello: World!')).toBe('hello-world');
      expect(generateSlugFromText('Test (with) [brackets]')).toBe('test-with-brackets');
    });

    it('should handle colons and commas', () => {
      expect(generateSlugFromText('Rows: KB1, KB2')).toBe('rows-kb1-kb2');
    });

    it('should collapse multiple hyphens', () => {
      expect(generateSlugFromText('test---multiple---hyphens')).toBe('test-multiple-hyphens');
    });

    it('should trim leading/trailing whitespace and hyphens', () => {
      expect(generateSlugFromText('  trimmed  ')).toBe('trimmed');
      expect(generateSlugFromText('-trim-')).toBe('trim');
    });

    it('should handle empty strings', () => {
      expect(generateSlugFromText('')).toBe('');
      expect(generateSlugFromText('   ')).toBe('');
    });
  });

  describe('generateDescriptionSlug', () => {
    it('should remove LED Kit suffix', () => {
      expect(generateDescriptionSlug('Full Ride LED Kit')).toBe('full-ride');
      expect(generateDescriptionSlug('Mainline LED Kit')).toBe('mainline');
    });

    it('should handle various LED Kit formats', () => {
      expect(generateDescriptionSlug('Full Ride led kit')).toBe('full-ride');
      expect(generateDescriptionSlug('Full Ride LED KIT')).toBe('full-ride');
      expect(generateDescriptionSlug('Full RideLEDKit')).toBe('full-ride');
    });

    it('should return empty string if only LED Kit remains', () => {
      expect(generateDescriptionSlug('LED Kit')).toBe('');
      expect(generateDescriptionSlug('  LED Kit  ')).toBe('');
    });

    it('should process descriptions without LED Kit', () => {
      expect(generateDescriptionSlug('Rows: KB1, KB2, 1-18 Columns: A-K')).toBe('rows-kb1-kb2-1-18-columns-a-k');
      expect(generateDescriptionSlug('Square')).toBe('square');
    });
  });
});

describe('Tension board URL slug symmetry', () => {
  describe('generateSizeSlug should produce slugs that match the expected URL format', () => {
    it('should generate correct slug for Tension Full Wall size', () => {
      // Tension size 1: name="Full Wall", description="Rows: KB1, KB2, 1-18 Columns: A-K"
      const slug = generateSizeSlug('Full Wall', 'Rows: KB1, KB2, 1-18 Columns: A-K');
      expect(slug).toBe('full-wall-rows-kb1-kb2-1-18-columns-a-k');
    });

    it('should generate correct slug for Tension Half Kickboard size', () => {
      // Tension size 2: name="Half Kickboard", description="Rows: KB2, 1-18 Columns: A-K"
      const slug = generateSizeSlug('Half Kickboard', 'Rows: KB2, 1-18 Columns: A-K');
      expect(slug).toBe('half-kickboard-rows-kb2-1-18-columns-a-k');
    });

    it('should generate correct slug for Tension No Kickboard size', () => {
      // Tension size 3: name="No Kickboard", description="Rows: 1-18 Columns: A-K"
      const slug = generateSizeSlug('No Kickboard', 'Rows: 1-18 Columns: A-K');
      expect(slug).toBe('no-kickboard-rows-1-18-columns-a-k');
    });

    it('should generate correct slug for Tension Short size', () => {
      // Tension size 4: name="Short", description="Rows: 1-15 Columns: A-K"
      const slug = generateSizeSlug('Short', 'Rows: 1-15 Columns: A-K');
      expect(slug).toBe('short-rows-1-15-columns-a-k');
    });

    it('should generate correct slug for Tension Board 2 size (non-standard dimension format)', () => {
      // Tension size 6: name="12 high x 12 wide", description=""
      // Note: This doesn't match the standard "12 x 12" pattern, so it falls back to text slug
      const slug = generateSizeSlug('12 high x 12 wide', '');
      expect(slug).toBe('12-high-x-12-wide');
    });

    it('should generate correct slug for standard dimension format', () => {
      // Standard dimension format extracts just the numbers
      expect(generateSizeSlug('12 x 12 Commercial', '')).toBe('12x12');
      expect(generateSizeSlug('10x12', 'Full Ride LED Kit')).toBe('10x12-full-ride');
    });
  });

  describe('slug generation consistency between generation and matching', () => {
    // These tests verify that generateSizeSlug produces the same slug that
    // getSizeBySlug will match against, ensuring URL symmetry

    it('should generate consistent slugs for non-dimensional sizes', () => {
      // Simulate what getSizeBySlug fallback does
      const generateMatchSlug = (name: string, description: string | undefined) => {
        let sizeSlug = generateSlugFromText(name);
        if (description && description.trim()) {
          const descSlug = generateDescriptionSlug(description);
          if (descSlug) {
            sizeSlug = `${sizeSlug}-${descSlug}`;
          }
        }
        return sizeSlug;
      };

      // Verify they produce the same output
      expect(generateSizeSlug('Full Wall', 'Rows: KB1, KB2, 1-18 Columns: A-K')).toBe(
        generateMatchSlug('Full Wall', 'Rows: KB1, KB2, 1-18 Columns: A-K'),
      );

      expect(generateSizeSlug('Half Kickboard', 'Rows: KB2, 1-18 Columns: A-K')).toBe(
        generateMatchSlug('Half Kickboard', 'Rows: KB2, 1-18 Columns: A-K'),
      );

      expect(generateSizeSlug('Custom Size', 'Full Ride LED Kit')).toBe(
        generateMatchSlug('Custom Size', 'Full Ride LED Kit'),
      );
    });
  });
});

describe('constructBoardSlugPlaylistsUrl', () => {
  it('should construct playlists URL from slug and angle', () => {
    expect(constructBoardSlugPlaylistsUrl('my-kilter', 40)).toBe('/b/my-kilter/40/playlists');
  });

  it('should handle angle 0', () => {
    expect(constructBoardSlugPlaylistsUrl('my-board', 0)).toBe('/b/my-board/0/playlists');
  });
});

describe('constructBoardSlugViewUrl', () => {
  it('should construct board-slug view URL with UUID when no climb name is provided', () => {
    expect(constructBoardSlugViewUrl('my-kilter', 40, 'ABC123')).toBe('/b/my-kilter/40/view/ABC123');
  });

  it('should construct board-slug view URL with climb slug and UUID when climb name is provided', () => {
    expect(constructBoardSlugViewUrl('my-kilter', 40, 'ABC123', 'Moon Landing')).toBe(
      '/b/my-kilter/40/view/moon-landing-ABC123',
    );
  });
});

describe('getContextAwareClimbViewUrl', () => {
  const boardDetails = {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 2,
    set_ids: [3, 4],
    layout_name: 'Homewall',
    size_name: '8x12 Full Ride',
    size_description: 'Main',
    set_names: ['Main Kicker', 'Aux Kicker'],
  } as unknown as BoardDetails;

  it('should preserve /b/{slug}/{angle} context from list routes', () => {
    expect(getContextAwareClimbViewUrl('/b/moonrise-gym/40/list', boardDetails, 40, 'ABC123', 'Moon Landing')).toBe(
      '/b/moonrise-gym/40/view/moon-landing-ABC123',
    );
  });

  it('should preserve /b/{slug}/{angle} context from play routes', () => {
    expect(
      getContextAwareClimbViewUrl('/b/moonrise-gym/40/play/some-climb', boardDetails, 40, 'ABC123', 'Moon Landing'),
    ).toBe('/b/moonrise-gym/40/view/moon-landing-ABC123');
  });

  it('should fall back to canonical URL outside /b routes', () => {
    expect(
      getContextAwareClimbViewUrl('/kilter/homewall/8x12/main_aux/40/list', boardDetails, 40, 'ABC123', 'Moon Landing'),
    ).toBe('/kilter/homewall/8x12-main/main-kicker_aux-kicker/40/view/moon-landing-ABC123');
  });
});

describe('getPlaylistsBasePath', () => {
  describe('board slug routes (/b/...)', () => {
    it('should extract base path from /b/{slug}/{angle}/playlists', () => {
      expect(getPlaylistsBasePath('/b/my-kilter/40/playlists')).toBe('/b/my-kilter/40/playlists');
    });

    it('should extract base path from /b/{slug}/{angle}/playlists/{uuid}', () => {
      expect(getPlaylistsBasePath('/b/my-kilter/40/playlists/ABC123')).toBe('/b/my-kilter/40/playlists');
    });

    it('should extract base path from /b/{slug}/{angle}/list', () => {
      expect(getPlaylistsBasePath('/b/my-kilter/40/list')).toBe('/b/my-kilter/40/playlists');
    });

    it('should extract base path from /b/{slug}/{angle}/play/{uuid}', () => {
      expect(getPlaylistsBasePath('/b/my-kilter/40/play/abc-123')).toBe('/b/my-kilter/40/playlists');
    });

    it('should handle slug with hyphens', () => {
      expect(getPlaylistsBasePath('/b/my-home-board/45/list')).toBe('/b/my-home-board/45/playlists');
    });
  });

  describe('old-style routes (/{board}/{layout}/{size}/{sets}/{angle}/...)', () => {
    it('should extract base path from old-style playlists URL', () => {
      expect(getPlaylistsBasePath('/kilter/original/12x12/default/45/playlists')).toBe(
        '/kilter/original/12x12/default/45/playlists',
      );
    });

    it('should extract base path from old-style playlist detail URL', () => {
      expect(getPlaylistsBasePath('/kilter/original/12x12/default/45/playlists/ABC123')).toBe(
        '/kilter/original/12x12/default/45/playlists',
      );
    });

    it('should extract base path from old-style list URL', () => {
      expect(getPlaylistsBasePath('/kilter/original/12x12/default/45/list')).toBe(
        '/kilter/original/12x12/default/45/playlists',
      );
    });

    it('should work for tension board', () => {
      expect(getPlaylistsBasePath('/tension/original/full-wall/screw_bolt/35/list')).toBe(
        '/tension/original/full-wall/screw_bolt/35/playlists',
      );
    });

    it('should work for moonboard', () => {
      expect(getPlaylistsBasePath('/moonboard/mini/default/holds/25/list')).toBe(
        '/moonboard/mini/default/holds/25/playlists',
      );
    });

    it('should not match non-board first segments', () => {
      expect(getPlaylistsBasePath('/playlists/some/extra/path/segments')).toBe('/playlists');
      expect(getPlaylistsBasePath('/settings/board/config/stuff/more')).toBe('/playlists');
    });
  });

  describe('global routes', () => {
    it('should return /playlists for /playlists', () => {
      expect(getPlaylistsBasePath('/playlists')).toBe('/playlists');
    });

    it('should return /playlists for /playlists/{uuid}', () => {
      expect(getPlaylistsBasePath('/playlists/ABC123')).toBe('/playlists');
    });

    it('should return /playlists for root', () => {
      expect(getPlaylistsBasePath('/')).toBe('/playlists');
    });

    it('should return /playlists for unrelated paths', () => {
      expect(getPlaylistsBasePath('/notifications')).toBe('/playlists');
      expect(getPlaylistsBasePath('/settings')).toBe('/playlists');
    });
  });
});

describe('getContextAwarePlaylistUrl', () => {
  it('should build board-slug scoped URL when on a /b/ route', () => {
    expect(getContextAwarePlaylistUrl('/b/my-kilter/40/playlists', 'ABC123')).toBe('/b/my-kilter/40/playlists/ABC123');
  });

  it('should build board-slug scoped URL when on /b/ list route', () => {
    expect(getContextAwarePlaylistUrl('/b/my-kilter/40/list', 'ABC123')).toBe('/b/my-kilter/40/playlists/ABC123');
  });

  it('should build old-style scoped URL when on an old-style route', () => {
    expect(getContextAwarePlaylistUrl('/kilter/original/12x12/default/45/list', 'ABC123')).toBe(
      '/kilter/original/12x12/default/45/playlists/ABC123',
    );
  });

  it('should build global URL when on a non-board route', () => {
    expect(getContextAwarePlaylistUrl('/playlists', 'ABC123')).toBe('/playlists/ABC123');
  });

  it('should build global URL when on root', () => {
    expect(getContextAwarePlaylistUrl('/', 'ABC123')).toBe('/playlists/ABC123');
  });
});

describe('constructClimbViewUrlWithSlugs', () => {
  it('should construct slug-based view URL with climb name', () => {
    const result = constructClimbViewUrlWithSlugs(
      'kilter',
      'Kilter Board Original',
      '16 x 12',
      'Super Wide',
      ['Bolt Ons', 'Screw Ons'],
      40,
      'abc123def456',
      'Breakfast Burrito',
    );
    expect(result).toBe('/kilter/original/16x12-super-wide/screw_bolt/40/view/breakfast-burrito-abc123def456');
  });

  it('should construct slug-based view URL without climb name', () => {
    const result = constructClimbViewUrlWithSlugs(
      'kilter',
      'Kilter Board Original',
      '16 x 12',
      'Super Wide',
      ['Bolt Ons', 'Screw Ons'],
      40,
      'abc123def456',
    );
    expect(result).toBe('/kilter/original/16x12-super-wide/screw_bolt/40/view/abc123def456');
  });

  it('should handle size without description', () => {
    const result = constructClimbViewUrlWithSlugs(
      'kilter',
      'Kilter Board Original',
      '12 x 12',
      undefined,
      ['Bolt Ons'],
      45,
      'uuid123',
    );
    expect(result).toBe('/kilter/original/12x12/bolt/45/view/uuid123');
  });

  it('should handle empty climb name', () => {
    const result = constructClimbViewUrlWithSlugs(
      'tension',
      'Tension Board 2 Mirror',
      '12 x 12',
      undefined,
      ['Wood', 'Plastic'],
      30,
      'uuid456',
      '',
    );
    expect(result).toBe('/tension/two-mirror/12x12/wood_plastic/30/view/uuid456');
  });
});

describe('constructClimbListWithSlugs', () => {
  it('should construct slug-based list URL', () => {
    const result = constructClimbListWithSlugs(
      'kilter',
      'Kilter Board Original',
      '16 x 12',
      'Super Wide',
      ['Bolt Ons', 'Screw Ons'],
      40,
    );
    expect(result).toBe('/kilter/original/16x12-super-wide/screw_bolt/40/list');
  });

  it('should handle size without description', () => {
    const result = constructClimbListWithSlugs(
      'tension',
      'Tension Board Original Layout',
      '8 x 12',
      undefined,
      ['Screw Ons'],
      25,
    );
    expect(result).toBe('/tension/original/8x12/screw/25/list');
  });
});

describe('getContextAwareClimbViewUrl - static data fallback', () => {
  it('should try static data when boardDetails lacks slug fields', () => {
    const detailsWithoutNames = {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1, 20],
      angle: 40,
    } as unknown as BoardDetails;

    const result = getContextAwareClimbViewUrl(
      '/kilter/1/7/1,20/40/list',
      detailsWithoutNames,
      40,
      'abc123',
      'Test Climb',
    );
    // Should resolve via getBoardDetailsForBoard and produce a slug URL
    expect(result).toContain('/kilter/original/');
    expect(result).toContain('/view/test-climb-abc123');
    expect(result).not.toMatch(/\/\d+\/\d+\//); // No numeric segments like /1/7/
  });

  it('should fall back to numeric URL when static data also fails', () => {
    const detailsWithInvalidIds = {
      board_name: 'kilter',
      layout_id: 9999,
      size_id: 9999,
      set_ids: [9999],
      angle: 40,
    } as unknown as BoardDetails;

    const result = getContextAwareClimbViewUrl(
      '/kilter/9999/9999/9999/40/list',
      detailsWithInvalidIds,
      40,
      'abc123',
      'Test Climb',
    );
    // Should fall back to numeric constructClimbViewUrl
    expect(result).toBe('/kilter/9999/9999/9999/40/view/test-climb-abc123');
  });
});

describe('tryConstructSlugViewUrl', () => {
  it('should return a slug-based view URL when static data resolves', () => {
    const result = tryConstructSlugViewUrl('kilter', 1, 7, [1, 20], 40, 'abc123', 'Test Climb');
    expect(result).not.toBeNull();
    expect(result).toContain('/kilter/');
    expect(result).toContain('/view/test-climb-abc123');
    expect(result).not.toMatch(/\/\d+\/\d+\//);
  });

  it('should return a slug-based view URL without climb name', () => {
    const result = tryConstructSlugViewUrl('kilter', 1, 7, [1, 20], 40, 'abc123');
    expect(result).not.toBeNull();
    expect(result).toContain('/view/abc123');
  });

  it('should return null when static data lookup fails', () => {
    const result = tryConstructSlugViewUrl('kilter', 9999, 9999, [9999], 40, 'abc123', 'Test');
    expect(result).toBeNull();
  });
});

describe('tryConstructSlugListUrl', () => {
  it('should return a slug-based list URL when static data resolves', () => {
    const result = tryConstructSlugListUrl('kilter', 1, 7, [1, 20], 40);
    expect(result).not.toBeNull();
    expect(result).toContain('/kilter/');
    expect(result).toContain('/list');
    expect(result).not.toMatch(/\/\d+\/\d+\//);
  });

  it('should return null when static data lookup fails', () => {
    const result = tryConstructSlugListUrl('kilter', 9999, 9999, [9999], 40);
    expect(result).toBeNull();
  });
});

/**
 * Kilter layout 1 carries two "12 x 12" squares — id 10 ("with kickboard") and
 * id 27 ("without kickboard") — and both name-slug to `12x12-square`. Only a
 * builder that has the size *id* can tell them apart, so every web surface that
 * canonicalises, redirects, or hands out a link has to go through the id-aware
 * builders. These pin that: id 10 keeps the bare slug every existing link
 * already means, id 27 gets the qualified one, and the two forms resolve back
 * to the sizes they were built from.
 */
describe('qualified size slugs for a shadowed size (Kilter layout 1, sizes 10/27)', () => {
  const KILTER_SQUARE_SETS = [1, 20];
  const BARE_VIEW_URL = '/kilter/original/12x12-square/screw_bolt/40/view/moon-landing-ABC123';
  const QUALIFIED_VIEW_URL = '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/view/moon-landing-ABC123';

  const squareWithKickboard = {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: KILTER_SQUARE_SETS,
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12 with kickboard',
    size_description: 'Square',
    set_names: ['Bolt Ons', 'Screw Ons'],
  } as unknown as BoardDetails;

  const squareWithoutKickboard = {
    ...squareWithKickboard,
    size_id: 27,
    size_name: '12 x 12 without kickboard',
  } as unknown as BoardDetails;

  describe('tryConstructSlugViewUrl / tryConstructSlugListUrl', () => {
    it('emits the qualified size slug for the shadowed size', () => {
      expect(tryConstructSlugViewUrl('kilter', 1, 27, KILTER_SQUARE_SETS, 40, 'ABC123', 'Moon Landing')).toBe(
        QUALIFIED_VIEW_URL,
      );
      expect(tryConstructSlugListUrl('kilter', 1, 27, KILTER_SQUARE_SETS, 40)).toBe(
        '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list',
      );
    });

    it('leaves the size that owns the bare slug on it, so existing links keep meaning what they meant', () => {
      expect(tryConstructSlugViewUrl('kilter', 1, 10, KILTER_SQUARE_SETS, 40, 'ABC123', 'Moon Landing')).toBe(
        BARE_VIEW_URL,
      );
      expect(tryConstructSlugListUrl('kilter', 1, 10, KILTER_SQUARE_SETS, 40)).toBe(
        '/kilter/original/12x12-square/screw_bolt/40/list',
      );
    });

    it('round-trips both forms back to the size each was built from', () => {
      expect(resolveSizeSlugToId('kilter', 1, '12x12-square-without-kickboard')).toBe(27);
      expect(resolveSizeSlugToId('kilter', 1, '12x12-square')).toBe(10);
    });
  });

  describe('popularConfigListUrl', () => {
    const shadowedConfig = {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 27,
      setIds: KILTER_SQUARE_SETS,
      layoutName: 'Kilter Board Original',
      sizeName: '12 x 12 without kickboard',
      sizeDescription: 'Square',
      setNames: ['Bolt Ons', 'Screw Ons'],
      displayName: 'Kilter 12x12 without kickboard',
      boardCount: 1,
    } as unknown as PopularBoardConfig;

    it('lets the ids win over the names on a shadowed size', () => {
      // The names alone slug to the bare 12x12-square — size 10's board. The
      // whole point of the helper is that a row carrying both never uses them.
      expect(popularConfigListUrl(shadowedConfig, 40)).toBe(
        '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list',
      );
    });

    it('falls back to the names when the static tables cannot resolve the ids', () => {
      const unresolvableIds = { ...shadowedConfig, layoutId: 9999, sizeId: 9999, setIds: [9999] };
      const nameBasedUrl = popularConfigListUrl(unresolvableIds, 40);
      expect(nameBasedUrl).toBe(
        constructClimbListWithSlugs(
          'kilter',
          'Kilter Board Original',
          '12 x 12 without kickboard',
          'Square',
          ['Bolt Ons', 'Screw Ons'],
          40,
        ),
      );
    });

    it('falls back to the numeric form when neither ids nor names resolve', () => {
      const bareConfig = {
        ...shadowedConfig,
        layoutId: 9999,
        sizeId: 9999,
        setIds: [9999],
        layoutName: null,
        sizeName: null,
        setNames: [],
      } as unknown as PopularBoardConfig;
      expect(popularConfigListUrl(bareConfig, 40)).toBe('/kilter/9999/9999/9999/40/list');
    });
  });

  describe('getContextAwareClimbViewUrl', () => {
    it('emits the qualified slug for the shadowed size even though slug names are present', () => {
      // Server-hydrated pages always carry layout_name/size_name/set_names, so
      // this is the case that used to silently take the name-based path.
      expect(
        getContextAwareClimbViewUrl('/kilter/1/27/1,20/40/list', squareWithoutKickboard, 40, 'ABC123', 'Moon Landing'),
      ).toBe(QUALIFIED_VIEW_URL);
    });

    it('is byte-identical to the name-based builder for a size that is not shadowed', () => {
      expect(
        getContextAwareClimbViewUrl('/kilter/1/10/1,20/40/list', squareWithKickboard, 40, 'ABC123', 'Moon Landing'),
      ).toBe(BARE_VIEW_URL);
      expect(
        constructClimbViewUrlWithSlugs(
          'kilter',
          'Kilter Board Original',
          '12 x 12 with kickboard',
          'Square',
          ['Bolt Ons', 'Screw Ons'],
          40,
          'ABC123',
          'Moon Landing',
        ),
      ).toBe(BARE_VIEW_URL);
    });

    it('still falls back to the name-based builder when the ids resolve to nothing', () => {
      // A DB-only board the static tables don't carry: ids are unresolvable, so
      // the names are the only thing left to slugify.
      const dbOnlyBoard = {
        board_name: 'kilter',
        layout_id: 9999,
        size_id: 9999,
        set_ids: [9999],
        layout_name: 'Kilter Board Homewall',
        size_name: '8 x 12',
        size_description: 'Home',
        set_names: ['Mainline'],
      } as unknown as BoardDetails;

      expect(
        getContextAwareClimbViewUrl('/kilter/9999/9999/9999/40/list', dbOnlyBoard, 40, 'ABC123', 'Moon Landing'),
      ).toBe('/kilter/homewall/8x12-home/main/40/view/moon-landing-ABC123');
    });

    it('preserves /b/{slug} routing context ahead of either builder', () => {
      expect(
        getContextAwareClimbViewUrl('/b/moonrise-gym/40/list', squareWithoutKickboard, 40, 'ABC123', 'Moon Landing'),
      ).toBe('/b/moonrise-gym/40/view/moon-landing-ABC123');
    });
  });
});

describe('extractAngleFromPathname', () => {
  it('reads the angle from /{board}/{layout}/{size}/{sets}/{angle}/play/{uuid}', () => {
    expect(extractAngleFromPathname('/kilter/8/25/28,29,26,27/35/play/abc-123')).toBe(35);
  });

  it('reads the angle from /{board}/{layout}/{size}/{sets}/{angle}/list', () => {
    expect(extractAngleFromPathname('/kilter/original/12x12/default/45/list')).toBe(45);
  });

  it('reads the angle from /b/{slug}/{angle}/...', () => {
    expect(extractAngleFromPathname('/b/marcos-wall/40/list')).toBe(40);
    expect(extractAngleFromPathname('/b/marcos-wall/35/play/xyz-789')).toBe(35);
  });

  it('handles slug-form paths terminating at the angle', () => {
    expect(extractAngleFromPathname('/b/marcos-wall/30')).toBe(30);
  });

  it('returns null for non-board routes', () => {
    expect(extractAngleFromPathname('/')).toBeNull();
    expect(extractAngleFromPathname('/you')).toBeNull();
    expect(extractAngleFromPathname('/playlists')).toBeNull();
    expect(extractAngleFromPathname('/playlists/abc-uuid')).toBeNull();
    expect(extractAngleFromPathname('/profile/marco')).toBeNull();
  });

  it('returns null when the angle segment is missing or non-numeric', () => {
    expect(extractAngleFromPathname('/kilter/8/25/28,29,26,27')).toBeNull();
    expect(extractAngleFromPathname('/kilter/8/25/28,29,26,27/notanangle/list')).toBeNull();
    expect(extractAngleFromPathname('/b/marcos-wall')).toBeNull();
    expect(extractAngleFromPathname('/b/marcos-wall/notanangle/list')).toBeNull();
  });

  it('handles negative angles (Aurora supports negative tilt readings on some boards)', () => {
    expect(extractAngleFromPathname('/kilter/8/25/28,29,26,27/-5/list')).toBe(-5);
    expect(extractAngleFromPathname('/b/marcos-wall/-5/list')).toBe(-5);
  });

  // `usePathname()` in Next.js returns the pre-rewrite URL including the
  // locale prefix for Spanish + French users. Before stripping the prefix,
  // the 5-segment regex matched the locale + board + layout + size + sets
  // shape and bailed at the comma-separated set IDs, returning null — the
  // angle then fell back to the session-creation value, reintroducing the
  // exact "angle reverts to 40°" bug this PR fixes, but only for non-
  // English users.
  describe('locale-prefixed pathnames', () => {
    it('handles /es/{board}/.../{angle}/... paths', () => {
      expect(extractAngleFromPathname('/es/kilter/8/25/28,29,26,27/35/play/abc-123')).toBe(35);
      expect(extractAngleFromPathname('/es/kilter/original/12x12/default/45/list')).toBe(45);
    });

    it('handles /fr/{board}/.../{angle}/... paths', () => {
      expect(extractAngleFromPathname('/fr/kilter/8/25/28,29,26,27/35/play/abc-123')).toBe(35);
      expect(extractAngleFromPathname('/fr/tension/two-zone/10x12/main_aux/40/list')).toBe(40);
    });

    it('handles /es/b/{slug}/{angle}/... slug routes', () => {
      expect(extractAngleFromPathname('/es/b/marcos-wall/40/list')).toBe(40);
      expect(extractAngleFromPathname('/fr/b/marcos-wall/-5/list')).toBe(-5);
    });

    it('handles 0° on locale-prefixed paths (vertical board, real angle)', () => {
      expect(extractAngleFromPathname('/es/kilter/8/25/28,29,26,27/0/list')).toBe(0);
      expect(extractAngleFromPathname('/fr/b/marcos-wall/0/list')).toBe(0);
    });

    it('does not strip the default en-US prefix (root paths only)', () => {
      // The default locale is served at root in this app — there is no
      // /en-US/ shape in production. If a stray /en-US/ ever appears the
      // helper should NOT silently strip it.
      expect(extractAngleFromPathname('/en-US/kilter/8/25/28,29,26,27/35/list')).toBeNull();
    });

    it('returns null for locale-prefixed off-board paths', () => {
      expect(extractAngleFromPathname('/es/you')).toBeNull();
      expect(extractAngleFromPathname('/fr/playlists')).toBeNull();
    });
  });
});

describe('replaceAngleInPathname', () => {
  it('replaces the angle on a canonical /{board}/.../{angle}/play/{uuid} path', () => {
    expect(replaceAngleInPathname('/kilter/8/25/28,29,26,27/35/play/abc-123', 40)).toBe(
      '/kilter/8/25/28,29,26,27/40/play/abc-123',
    );
  });

  it('replaces the angle on a /{board}/.../{angle}/list path', () => {
    expect(replaceAngleInPathname('/kilter/original/12x12/default/35/list', 45)).toBe(
      '/kilter/original/12x12/default/45/list',
    );
  });

  it('replaces the angle on a /b/{slug}/{angle}/... path', () => {
    expect(replaceAngleInPathname('/b/marcos-wall/35/list', 40)).toBe('/b/marcos-wall/40/list');
    expect(replaceAngleInPathname('/b/marcos-wall/35/play/abc-123', 25)).toBe('/b/marcos-wall/25/play/abc-123');
  });

  // Regression for the angle-selector linear-search bug: a path where the
  // layout id happens to equal the current angle would match the layout
  // segment first, producing /kilter/40/10/1/40/list (wrong) instead of
  // /kilter/1/10/1/40/list (right). Positional replacement avoids this.
  it('replaces only the angle slot when the layout id has the same numeric value', () => {
    expect(replaceAngleInPathname('/kilter/1/10/1/40/list', 25)).toBe('/kilter/1/10/1/25/list');
    expect(replaceAngleInPathname('/kilter/40/10/1/40/play/abc-123', 25)).toBe('/kilter/40/10/1/25/play/abc-123');
  });

  it('preserves the /es/ locale prefix while replacing the angle', () => {
    expect(replaceAngleInPathname('/es/kilter/8/25/28,29,26,27/35/play/abc-123', 40)).toBe(
      '/es/kilter/8/25/28,29,26,27/40/play/abc-123',
    );
    expect(replaceAngleInPathname('/es/b/marcos-wall/35/list', 40)).toBe('/es/b/marcos-wall/40/list');
  });

  it('preserves the /fr/ locale prefix while replacing the angle', () => {
    expect(replaceAngleInPathname('/fr/tension/two-zone/10x12/main_aux/40/list', 35)).toBe(
      '/fr/tension/two-zone/10x12/main_aux/35/list',
    );
  });

  it('handles 0° on both shapes (vertical board)', () => {
    expect(replaceAngleInPathname('/kilter/8/25/28,29,26,27/35/list', 0)).toBe('/kilter/8/25/28,29,26,27/0/list');
    expect(replaceAngleInPathname('/b/marcos-wall/35/list', 0)).toBe('/b/marcos-wall/0/list');
  });

  it('handles negative angles', () => {
    expect(replaceAngleInPathname('/kilter/8/25/28,29,26,27/35/list', -5)).toBe('/kilter/8/25/28,29,26,27/-5/list');
  });

  it('returns null for non-board paths (caller treats as "do not navigate")', () => {
    expect(replaceAngleInPathname('/you', 40)).toBeNull();
    expect(replaceAngleInPathname('/playlists', 40)).toBeNull();
    expect(replaceAngleInPathname('/kilter/8/25/28,29,26,27', 40)).toBeNull(); // no angle segment
    expect(replaceAngleInPathname('/b/marcos-wall', 40)).toBeNull(); // no angle segment
    expect(replaceAngleInPathname('/kilter/8/25/28,29,26,27/notanangle/list', 40)).toBeNull();
  });
});

/**
 * `buildCanonicalClimbListUrl` is the list twin of `buildCanonicalClimbViewUrl`,
 * and both `/list` front doors call it — the config-tuple tree's page and
 * `/b/{slug}/{angle}/list`, which cross-canonicalises into that tree (A1,
 * #4369). One function is what makes "both trees emit the identical canonical"
 * a fact rather than a hope.
 */
describe('buildCanonicalClimbListUrl', () => {
  const KILTER_SQUARE_SETS = [1, 20];

  const namesOnlyBoard = {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: KILTER_SQUARE_SETS,
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12 with kickboard',
    size_description: 'Square',
    set_names: ['Bolt Ons', 'Screw Ons'],
  } as unknown as BoardDetails;

  it('emits the id-aware named-slug list URL', () => {
    expect(buildCanonicalClimbListUrl(namesOnlyBoard, 40)).toBe('/kilter/original/12x12-square/screw_bolt/40/list');
  });

  it('emits the QUALIFIED size slug for a shadowed size, not the bare one', () => {
    // Kilter layout 1 sizes 10 and 27 both name-slug to `12x12-square`. Only the
    // id-aware path can tell them apart; a name-slugged canonical for size 27
    // would point at size 10 — a different physical board.
    const shadowed = { ...namesOnlyBoard, size_id: 27, size_name: '12 x 12 without kickboard' } as BoardDetails;
    expect(buildCanonicalClimbListUrl(shadowed, 40)).toBe(
      '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list',
    );
  });

  it('falls back to the numeric form for a config the static tables and names cannot resolve', () => {
    const unknownBoard = {
      board_name: 'kilter',
      layout_id: 9999,
      size_id: 8888,
      set_ids: [7777],
    } as unknown as BoardDetails;
    expect(buildCanonicalClimbListUrl(unknownBoard, 25)).toBe('/kilter/9999/8888/7777/25/list');
  });

  it('carries the angle through', () => {
    expect(buildCanonicalClimbListUrl(namesOnlyBoard, 25)).toContain('/25/list');
    expect(buildCanonicalClimbListUrl(namesOnlyBoard, 70)).toContain('/70/list');
  });
});
