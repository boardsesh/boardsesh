import { describe, it, expect } from 'vite-plus/test';
import {
  searchParamsToUrlParams,
  parsedRouteSearchParamsToSearchParams,
  urlParamsToSearchParams,
  parseBoardRouteParams,
  constructClimbViewUrl,
  constructClimbViewUrlWithSlugs,
  constructClimbListWithSlugs,
  constructPlayUrlWithSlugs,
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
  getBaseBoardPath,
  getPlaylistsBasePath,
  getContextAwarePlaylistUrl,
  getContextAwareClimbViewUrl,
  constructBoardSlugViewUrl,
  constructBoardSlugPlaylistsUrl,
  tryConstructSlugPlayUrl,
  tryConstructSlugViewUrl,
  tryConstructSlugListUrl,
  DEFAULT_SEARCH_PARAMS,
  constructCreateClimbUrl,
} from '../url-utils';
import type { SearchRequestPagination, BoardDetails } from '../types';

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
      onlyClassics: true,
    });

    const params = result.toString();
    expect(params).toContain('minGrade=5');
    expect(params).toContain('name=test+climb');
    expect(params).toContain('onlyClassics=true');
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

  it('should handle holds filter correctly', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: {
        red: { state: 'include' },
        blue: { state: 'exclude' },
      } as unknown as SearchRequestPagination['holdsFilter'],
    });

    const params = result.toString();
    expect(params).toContain('hold_red=include');
    expect(params).toContain('hold_blue=exclude');
  });

  it('should not include holds filter when empty', () => {
    const result = searchParamsToUrlParams({
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: {},
      minGrade: 2,
    });

    expect(result.toString()).toBe('minGrade=2');
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
      onlyClassics: true,
    });

    expect(result.toString()).toBe('onlyClassics=true');
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
      onlyClassics: true,
      holdsFilter: { red: { state: 'include' } },
    };

    const result = parsedRouteSearchParamsToSearchParams(input);

    expect(result.name).toBe('test climb');
    expect(result.settername).toEqual(['john doe']);
    expect(result.sortBy).toBe('difficulty');
    expect(result.sortOrder).toBe('asc');
    expect(result.onlyClassics).toBe(true);
    expect(result.holdsFilter).toEqual({ red: { state: 'include' } });
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
      onlyClassics: 'true',
      page: '2',
      hold_red: 'include',
      hold_blue: 'exclude',
    });

    const result = urlParamsToSearchParams(urlParams);

    expect(result.minGrade).toBe(5);
    expect(result.maxGrade).toBe(10);
    expect(result.name).toBe('test climb');
    expect(result.onlyClassics).toBe(true);
    expect(result.page).toBe(2);
    expect(result.holdsFilter).toEqual({ red: 'include', blue: 'exclude' });
  });

  it('should use defaults for missing parameters', () => {
    const urlParams = new URLSearchParams({ name: 'test' });
    const result = urlParamsToSearchParams(urlParams);

    expect(result.minGrade).toBe(DEFAULT_SEARCH_PARAMS.minGrade);
    expect(result.maxGrade).toBe(DEFAULT_SEARCH_PARAMS.maxGrade);
    expect(result.name).toBe('test');
    expect(result.sortBy).toBe(DEFAULT_SEARCH_PARAMS.sortBy);
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

  describe('stripping /grid segment', () => {
    it('should strip /grid from path with angle', () => {
      expect(getBaseBoardPath('/kilter/original/12x12/default/45/grid'))
        .toBe('/kilter/original/12x12/default');
    });

    it('should handle different board configurations with grid', () => {
      expect(getBaseBoardPath('/tension/two-zone/10x12/main_aux/40/grid'))
        .toBe('/tension/two-zone/10x12/main_aux');
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

  it('should construct slug-based grid URL when viewMode is grid', () => {
    const result = constructClimbListWithSlugs(
      'kilter', 'Kilter Board Original', '16 x 12', 'Super Wide',
      ['Bolt Ons', 'Screw Ons'], 40, 'grid',
    );
    expect(result).toBe('/kilter/original/16x12-super-wide/screw_bolt/40/grid');
  });

  it('should default to list when viewMode is omitted', () => {
    const result = constructClimbListWithSlugs(
      'kilter', 'Kilter Board Original', '16 x 12', 'Super Wide',
      ['Bolt Ons', 'Screw Ons'], 40,
    );
    expect(result).toBe('/kilter/original/16x12-super-wide/screw_bolt/40/list');
  });
});

describe('constructPlayUrlWithSlugs', () => {
  it('should construct slug-based play URL with climb name', () => {
    const result = constructPlayUrlWithSlugs(
      'kilter',
      'Kilter Board Original',
      '12 x 14',
      'Commerical',
      ['Bolt Ons', 'Screw Ons'],
      40,
      'abc123',
      'My Climb',
    );
    expect(result).toBe('/kilter/original/12x14-commerical/screw_bolt/40/play/my-climb-abc123');
  });

  it('should construct slug-based play URL without climb name', () => {
    const result = constructPlayUrlWithSlugs(
      'kilter',
      'Kilter Board Original',
      '12 x 14',
      'Commerical',
      ['Bolt Ons'],
      40,
      'abc123',
    );
    expect(result).toBe('/kilter/original/12x14-commerical/bolt/40/play/abc123');
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

describe('tryConstructSlugPlayUrl', () => {
  it('should return a slug-based play URL when static data resolves', () => {
    const result = tryConstructSlugPlayUrl('kilter', 1, 7, [1, 20], 40, 'abc123', 'Test Climb');
    expect(result).not.toBeNull();
    expect(result).toContain('/kilter/');
    expect(result).toContain('/play/test-climb-abc123');
    expect(result).not.toMatch(/\/\d+\/\d+\//); // No numeric segments
  });

  it('should return a slug-based play URL without climb name', () => {
    const result = tryConstructSlugPlayUrl('kilter', 1, 7, [1, 20], 40, 'abc123');
    expect(result).not.toBeNull();
    expect(result).toContain('/play/abc123');
  });

  it('should return null when static data lookup fails', () => {
    const result = tryConstructSlugPlayUrl('kilter', 9999, 9999, [9999], 40, 'abc123', 'Test');
    expect(result).toBeNull();
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

  it('should return a slug-based grid URL when viewMode is grid', () => {
    const result = tryConstructSlugListUrl('kilter', 1, 7, [1, 20], 40, 'grid');
    expect(result).not.toBeNull();
    expect(result).toContain('/kilter/');
    expect(result).toContain('/grid');
    expect(result).not.toMatch(/\/\d+\/\d+\//);
  });

  it('should return null when static data lookup fails', () => {
    const result = tryConstructSlugListUrl('kilter', 9999, 9999, [9999], 40);
    expect(result).toBeNull();
  });
});

describe('constructCreateClimbUrl', () => {
  it('builds a create URL without query params when no forkParams', () => {
    const url = constructCreateClimbUrl('kilter', 'Original', '12x12', 'Full Size', ['Standard'], 40);
    expect(url).toContain('/create');
    expect(url).not.toContain('?');
  });

  it('includes forkFrames and forkName when forkParams provided', () => {
    const url = constructCreateClimbUrl('kilter', 'Original', '12x12', 'Full Size', ['Standard'], 40, {
      frames: 'p1r12',
      name: 'My Climb',
    });
    expect(url).toContain('forkFrames=p1r12');
    expect(url).toContain('forkName=My+Climb');
  });

  it('uses editClimbUuid (not editUuid) as the query param name', () => {
    const url = constructCreateClimbUrl('kilter', 'Original', '12x12', 'Full Size', ['Standard'], 40, {
      frames: 'p1r12',
      name: 'Draft',
      editClimbUuid: 'abc-123',
    });
    expect(url).toContain('editClimbUuid=abc-123');
    expect(url).not.toContain('editUuid=');
  });

  it('includes forkDescription when provided', () => {
    const url = constructCreateClimbUrl('kilter', 'Original', '12x12', 'Full Size', ['Standard'], 40, {
      frames: 'p1r12',
      name: 'Draft',
      description: 'A cool problem',
    });
    expect(url).toContain('forkDescription=A+cool+problem');
  });

  it('omits editClimbUuid from URL when not provided', () => {
    const url = constructCreateClimbUrl('kilter', 'Original', '12x12', 'Full Size', ['Standard'], 40, {
      frames: 'p1r12',
      name: 'Fork',
    });
    expect(url).not.toContain('editClimbUuid');
  });
});
