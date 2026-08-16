import { describe, it, expect } from 'vite-plus/test';
import {
  DIRECTORY_FACETS,
  FACET_BASE_PATHS,
  buildDirectoryHref,
  buildFacetSwitchHref,
  distanceKm,
  isSearchApplication,
  paginationWindow,
  parseDirectoryQuery,
} from '../directory-facets';

describe('facet routes', () => {
  it('ships exactly four literal routes and no long-tail ones', () => {
    expect([...DIRECTORY_FACETS]).toEqual(['all', 'kilter', 'moonboard', 'tension']);
    expect(FACET_BASE_PATHS).toEqual({
      all: '/gyms',
      kilter: '/gyms/kilter',
      moonboard: '/gyms/moonboard',
      tension: '/gyms/tension',
    });
    // grasshopper/decoy/soill/touchstone are query-param only — DB-04 puts them
    // one to two orders of magnitude below the three that get a page.
    expect(Object.values(FACET_BASE_PATHS)).not.toContain('/gyms/soill');
  });
});

describe('parseDirectoryQuery', () => {
  it('defaults to an unfiltered first page', () => {
    expect(parseDirectoryQuery('all', {})).toEqual({
      query: '',
      boardTypes: [],
      latitude: null,
      longitude: null,
      radiusKm: null,
      page: 1,
    });
  });

  it('pins a facet route to its own board type', () => {
    expect(parseDirectoryQuery('kilter', {}).boardTypes).toEqual(['kilter']);
  });

  it('ignores ?boardType on a facet route so the h1 never lies about the list', () => {
    expect(parseDirectoryQuery('kilter', { boardType: 'tension' }).boardTypes).toEqual(['kilter']);
  });

  it('accepts long-tail board types as a query param on /gyms', () => {
    expect(parseDirectoryQuery('all', { boardType: ['soill', 'decoy'] }).boardTypes).toEqual(['decoy', 'soill']);
  });

  it('drops board types nobody has ever built', () => {
    expect(parseDirectoryQuery('all', { boardType: ['not-a-board', 'kilter'] }).boardTypes).toEqual(['kilter']);
  });

  it('trims and caps the free-text query', () => {
    expect(parseDirectoryQuery('all', { q: '  bristol  ' }).query).toBe('bristol');
    expect(parseDirectoryQuery('all', { q: 'x'.repeat(500) }).query).toHaveLength(80);
  });

  it('takes coordinates only as a valid pair', () => {
    const both = parseDirectoryQuery('all', { lat: '51.45', lng: '-2.58' });
    expect([both.latitude, both.longitude]).toEqual([51.45, -2.58]);

    expect(parseDirectoryQuery('all', { lat: '51.45' }).latitude).toBeNull();
    expect(parseDirectoryQuery('all', { lat: '95', lng: '0' }).latitude).toBeNull();
    expect(parseDirectoryQuery('all', { lat: 'north', lng: '0' }).latitude).toBeNull();
  });

  it('clamps the radius and drops it without an origin', () => {
    expect(parseDirectoryQuery('all', { lat: '0', lng: '0', radius: '9000' }).radiusKm).toBe(500);
    expect(parseDirectoryQuery('all', { lat: '0', lng: '0', radius: '0' }).radiusKm).toBe(1);
    expect(parseDirectoryQuery('all', { radius: '25' }).radiusKm).toBeNull();
  });

  it('floors page at one but never clamps the top', () => {
    expect(parseDirectoryQuery('all', { page: '3' }).page).toBe(3);
    expect(parseDirectoryQuery('all', { page: '-4' }).page).toBe(1);
    expect(parseDirectoryQuery('all', { page: '0' }).page).toBe(1);
    expect(parseDirectoryQuery('all', { page: '2.7' }).page).toBe(2);
    expect(parseDirectoryQuery('all', { page: 'next' }).page).toBe(1);
    // Deliberately NOT clamped: an out-of-range page has to reach the renderer
    // so it can 404. Clamping served a 200 whose URL and highlighted page
    // number disagreed.
    expect(parseDirectoryQuery('all', { page: '9999' }).page).toBe(9999);
  });
});

describe('buildDirectoryHref', () => {
  const base = parseDirectoryQuery('all', {});

  it('returns the clean base for page one with no filters', () => {
    expect(buildDirectoryHref('all', base, 1)).toBe('/gyms');
    expect(buildDirectoryHref('kilter', parseDirectoryQuery('kilter', {}), 1)).toBe('/gyms/kilter');
  });

  it('keeps a facet board type in the path, never the query', () => {
    const kilter = parseDirectoryQuery('kilter', {});
    expect(buildDirectoryHref('kilter', kilter, 2)).toBe('/gyms/kilter?page=2');
  });

  it('carries search, board filter and location across pages', () => {
    const query = parseDirectoryQuery('all', {
      q: 'bristol',
      boardType: 'soill',
      lat: '51.45',
      lng: '-2.58',
      radius: '25',
    });
    expect(buildDirectoryHref('all', query, 3)).toBe(
      '/gyms?q=bristol&boardType=soill&lat=51.45&lng=-2.58&radius=25&page=3',
    );
  });

  it('emits the same string for the same state regardless of param order in', () => {
    const one = parseDirectoryQuery('all', { boardType: ['decoy', 'soill'], q: 'x' });
    const two = parseDirectoryQuery('all', { q: 'x', boardType: ['soill', 'decoy'] });
    expect(buildDirectoryHref('all', one, 1)).toBe(buildDirectoryHref('all', two, 1));
  });
});

describe('isSearchApplication', () => {
  it('is false for a bare /gyms visit', () => {
    expect(isSearchApplication('all', parseDirectoryQuery('all', {}))).toBe(false);
  });

  it('is false for a plain facet pageview', () => {
    // The board type is the ROUTE, not a filter the visitor applied. Counting
    // it made every /gyms/kilter pageview a search with queryLength 0.
    for (const facet of ['kilter', 'moonboard', 'tension'] as const) {
      expect(isSearchApplication(facet, parseDirectoryQuery(facet, {}))).toBe(false);
    }
  });

  it('is false on page two and beyond, on every route', () => {
    // ?page=N is a full navigation, so the tracker remounts. Page 2 of one
    // search is not a second search.
    expect(isSearchApplication('all', parseDirectoryQuery('all', { q: 'bristol', page: '2' }))).toBe(false);
    expect(isSearchApplication('kilter', parseDirectoryQuery('kilter', { q: 'bristol', page: '3' }))).toBe(false);
  });

  it('is true for free text, on the flat route and on a facet', () => {
    expect(isSearchApplication('all', parseDirectoryQuery('all', { q: 'bristol' }))).toBe(true);
    expect(isSearchApplication('kilter', parseDirectoryQuery('kilter', { q: 'bristol' }))).toBe(true);
  });

  it('is true for a location', () => {
    expect(isSearchApplication('all', parseDirectoryQuery('all', { lat: '51.45', lng: '-2.58' }))).toBe(true);
  });

  it('is true for an explicit ?boardType on the unfaceted route only', () => {
    expect(isSearchApplication('all', parseDirectoryQuery('all', { boardType: 'soill' }))).toBe(true);
    expect(isSearchApplication('kilter', parseDirectoryQuery('kilter', { boardType: 'soill' }))).toBe(false);
  });
});

describe('buildFacetSwitchHref', () => {
  it('keeps an active search when switching board', () => {
    const query = parseDirectoryQuery('all', { q: 'bristol' });
    expect(buildFacetSwitchHref('kilter', query)).toBe('/gyms/kilter?q=bristol');
  });

  it('keeps an active search when clearing the board filter', () => {
    const query = parseDirectoryQuery('kilter', { q: 'bristol' });
    expect(buildFacetSwitchHref('all', query)).toBe('/gyms?q=bristol');
  });

  it('replaces the board filter rather than merging it', () => {
    const query = parseDirectoryQuery('kilter', {});
    expect(buildFacetSwitchHref('tension', query)).toBe('/gyms/tension');
    expect(buildFacetSwitchHref('all', parseDirectoryQuery('all', { boardType: 'soill' }))).toBe('/gyms');
  });

  it('keeps the location and drops the page', () => {
    const query = parseDirectoryQuery('all', { lat: '51.45', lng: '-2.58', radius: '25', page: '4' });
    expect(buildFacetSwitchHref('moonboard', query)).toBe('/gyms/moonboard?lat=51.45&lng=-2.58&radius=25');
  });
});

describe('distanceKm', () => {
  it('is zero for the same point', () => {
    expect(distanceKm({ latitude: 51.45, longitude: -2.58 }, { latitude: 51.45, longitude: -2.58 })).toBe(0);
  });

  it('matches a known separation', () => {
    // Bristol -> Bath, about 17 km as the crow flies.
    const km = distanceKm({ latitude: 51.4545, longitude: -2.5879 }, { latitude: 51.3811, longitude: -2.359 });
    expect(km).toBeGreaterThan(16);
    expect(km).toBeLessThan(19);
  });
});

describe('paginationWindow', () => {
  it('renders nothing when there is one page', () => {
    expect(paginationWindow(1, 1)).toEqual([]);
  });

  it('shows the first pages from the start', () => {
    expect(paginationWindow(1, 20)).toEqual([1, 2, 3, 4, 5]);
  });

  it('centres on the current page in the middle', () => {
    expect(paginationWindow(10, 20)).toEqual([8, 9, 10, 11, 12]);
  });

  it('sticks to the end rather than running past it', () => {
    expect(paginationWindow(20, 20)).toEqual([16, 17, 18, 19, 20]);
  });

  it('never emits more pages than exist', () => {
    expect(paginationWindow(2, 3)).toEqual([1, 2, 3]);
  });
});
