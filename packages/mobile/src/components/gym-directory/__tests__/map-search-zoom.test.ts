import { describe, expect, it } from 'vitest';
import { SEARCH_ZOOM_THRESHOLD, zoomedInToSearch } from '../map-search-zoom';

describe('zoomedInToSearch', () => {
  it.each([
    { zoom: 2, hasSearchCenter: true, searches: false },
    { zoom: 2, hasSearchCenter: false, searches: false },
    { zoom: SEARCH_ZOOM_THRESHOLD, hasSearchCenter: false, searches: true },
    { zoom: 11, hasSearchCenter: true, searches: true },
    { zoom: undefined, hasSearchCenter: true, searches: true },
    { zoom: undefined, hasSearchCenter: false, searches: false },
  ])('zoom $zoom (centre: $hasSearchCenter) searches: $searches', ({ zoom, hasSearchCenter, searches }) => {
    expect(zoomedInToSearch(zoom, hasSearchCenter)).toBe(searches);
  });
});
