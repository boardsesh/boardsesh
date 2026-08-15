import { describe, it, expect } from 'vite-plus/test';
import type { TFunction } from 'i18next';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { DIRECTORY_FACETS, type DirectoryFacet } from '../directory-facets';
import {
  facetChipLabel,
  facetDetail,
  facetHeading,
  facetLead,
  facetLinkLabel,
  facetMetaDescription,
  facetMetaTitle,
} from '../directory-copy';

const t = ((key: string, options?: Record<string, unknown>) =>
  tFromCatalog('gyms', key, options)) as unknown as TFunction<'gyms'>;

const counts = { all: 4201, kilter: 1786, moonboard: 2586, tension: 465 };
const formatNumber = (value: number) => new Intl.NumberFormat('en-US').format(value);

describe('per-facet copy', () => {
  it('resolves a real catalog string for every facet, not a bare key', () => {
    for (const facet of DIRECTORY_FACETS) {
      expect(facetMetaTitle(t, facet)).not.toContain('metadata.');
      expect(facetMetaDescription(t, facet)).not.toContain('metadata.');
      expect(facetHeading(t, facet)).not.toContain('directory.');
      expect(facetLead(t, facet, counts, formatNumber)).not.toContain('directory.');
      expect(facetDetail(t, facet, counts, formatNumber)).not.toContain('directory.');
      expect(facetChipLabel(t, facet, counts, formatNumber)).not.toContain('facets.');
      expect(facetLinkLabel(t, facet)).not.toContain('links.');
    }
  });

  it('gives every facet a distinct title and h1', () => {
    const titles = DIRECTORY_FACETS.map((facet) => facetMetaTitle(t, facet));
    expect(new Set(titles).size).toBe(DIRECTORY_FACETS.length);

    const headings = DIRECTORY_FACETS.map((facet) => facetHeading(t, facet));
    expect(new Set(headings).size).toBe(DIRECTORY_FACETS.length);
  });

  it('names each board with the right capitalisation', () => {
    expect(facetHeading(t, 'kilter')).toContain('Kilter');
    expect(facetHeading(t, 'moonboard')).toContain('MoonBoard');
    expect(facetHeading(t, 'tension')).toContain('Tension');
  });

  it('describes compatibility, never affiliation', () => {
    const everything = DIRECTORY_FACETS.flatMap((facet: DirectoryFacet) => [
      facetMetaTitle(t, facet),
      facetMetaDescription(t, facet),
      facetHeading(t, facet),
      facetLead(t, facet, counts, formatNumber),
      facetDetail(t, facet, counts, formatNumber),
    ]).join(' ');

    for (const forbidden of ['Kilter app', 'MoonBoard app', 'Tension app', 'official', 'partner', 'endorsed']) {
      expect(everything.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('live counts', () => {
  it('renders the facet total in the lead paragraph, locale formatted', () => {
    expect(facetLead(t, 'kilter', counts, formatNumber)).toContain('1,786');
    expect(facetLead(t, 'all', counts, formatNumber)).toContain('4,201');
  });

  it('picks the singular form for a facet with one gym', () => {
    const single = { all: 1, kilter: 1, moonboard: 1, tension: 1 };
    expect(facetLead(t, 'tension', single, formatNumber)).toContain('1 gym on Boardsesh has');
  });

  it('breaks the total down by board on /gyms', () => {
    const detail = facetDetail(t, 'all', counts, formatNumber);
    expect(detail).toContain('1,786');
    expect(detail).toContain('2,586');
    expect(detail).toContain('465');
  });

  it('puts the count on every facet chip', () => {
    expect(facetChipLabel(t, 'moonboard', counts, formatNumber)).toBe('MoonBoard · 2,586');
    expect(facetChipLabel(t, 'all', counts, formatNumber)).toBe('All gyms · 4,201');
  });
});
