import { describe, expect, it } from 'vite-plus/test';
import { SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import {
  allLocalesUrlCount,
  buildAlternates,
  expandAllLocales,
  expandDefaultLocaleOnly,
  expandLocales,
  latestLastModified,
} from '../entries';
import { renderUrlset } from '../sitemap-xml';

describe('expandLocales', () => {
  const entries = expandLocales({ path: '/playlists/abc', lastModified: new Date('2026-04-30T00:00:00.000Z') });

  it('fans one item into exactly one url per locale', () => {
    expect(entries).toHaveLength(SUPPORTED_LOCALES.length);
    expect(entries.map((entry) => entry.loc)).toEqual([
      'https://www.boardsesh.com/playlists/abc',
      'https://www.boardsesh.com/es/playlists/abc',
      'https://www.boardsesh.com/fr/playlists/abc',
      'https://www.boardsesh.com/de/playlists/abc',
    ]);
  });

  it('gives every locale variant the identical five-key alternates map', () => {
    // This is the machine-checkable hreflang-return proof: Search Console's "no
    // return links" error is exactly the case where these maps differ.
    const expected = {
      'en-US': 'https://www.boardsesh.com/playlists/abc',
      es: 'https://www.boardsesh.com/es/playlists/abc',
      fr: 'https://www.boardsesh.com/fr/playlists/abc',
      de: 'https://www.boardsesh.com/de/playlists/abc',
      'x-default': 'https://www.boardsesh.com/playlists/abc',
    };
    for (const entry of entries) {
      expect(entry.alternates).toEqual(expected);
    }
  });

  it('leaves the default locale unprefixed and points x-default at it', () => {
    const alternates = buildAlternates('/about');
    expect(alternates['en-US']).toBe('https://www.boardsesh.com/about');
    expect(alternates['x-default']).toBe(alternates['en-US']);
  });

  it('emits absolute URLs only', () => {
    for (const entry of expandAllLocales([{ path: '/about' }, { path: '/' }])) {
      expect(entry.loc.startsWith('https://www.boardsesh.com')).toBe(true);
    }
  });

  it('carries a null lastModified through rather than inventing one', () => {
    for (const entry of expandLocales({ path: '/about' })) {
      expect(entry.lastModified).toBeNull();
    }
  });
});

describe('allLocalesUrlCount', () => {
  it('matches what expandAllLocales would actually build', () => {
    // The index checks the URL budget with the cheap count instead of building
    // up to 45,000 entries it would throw away. That is only sound while the two
    // agree, so pin them against each other rather than against a literal.
    for (const items of [[], [{ path: '/about' }], [{ path: '/a' }, { path: '/b' }, { path: '/c' }]]) {
      expect(allLocalesUrlCount(items)).toBe(expandAllLocales(items).length);
    }
  });
});

describe('expandDefaultLocaleOnly', () => {
  const lastModified = new Date('2026-04-30T00:00:00.000Z');
  const entries = expandDefaultLocaleOnly([
    { path: '/kilter/original/12x12-square/screw_bolt/40/view/climb-abc', lastModified },
    { path: '/kilter/original/12x12-square/screw_bolt/40/view/climb-def', lastModified },
  ]);

  it('emits exactly one url per item, on the unprefixed default locale', () => {
    expect(entries).toHaveLength(2);
    expect(entries[0].loc).toBe('https://www.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/view/climb-abc');
    expect(entries.some((entry) => entry.loc.includes('/es/'))).toBe(false);
  });

  it('emits no alternates at all — a partial hreflang set is worse than none', () => {
    // A one-sided annotation is a non-reciprocal signal; the locale twins carry
    // reciprocal HTML hreflang from createPageMetadata instead.
    for (const entry of entries) {
      expect(entry.alternates).toBeUndefined();
    }
    expect(renderUrlset(entries)).not.toContain('xmlns:xhtml');
  });

  it('passes the real timestamp through', () => {
    expect(entries[0].lastModified).toBe(lastModified);
  });
});

describe('latestLastModified', () => {
  it('returns the newest real timestamp, or null when nothing has one', () => {
    expect(
      latestLastModified([
        { path: '/a', lastModified: new Date('2026-01-01') },
        { path: '/b', lastModified: new Date('2026-04-30') },
        { path: '/c' },
      ]),
    ).toEqual(new Date('2026-04-30'));

    expect(latestLastModified([{ path: '/a' }, { path: '/b', lastModified: null }])).toBeNull();
  });
});
