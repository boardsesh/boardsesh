import { describe, expect, it } from 'vite-plus/test';
import { isSupportedLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../config';
import { localeHref, stripLocalePrefix } from '../locale-href';
import { detectLocale } from '../detect-locale';

describe('isSupportedLocale', () => {
  it('accepts every entry in SUPPORTED_LOCALES', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(isSupportedLocale(locale)).toBe(true);
    }
  });

  it('rejects unsupported strings, null, and undefined', () => {
    expect(isSupportedLocale('ja')).toBe(false);
    expect(isSupportedLocale('en')).toBe(false); // we use 'en-US', not 'en'
    expect(isSupportedLocale('de-DE')).toBe(false); // we use 'de', not 'de-DE'
    expect(isSupportedLocale('es-MX')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });
});

describe('localeHref', () => {
  it('returns the path unchanged for the default locale', () => {
    expect(localeHref('/about', 'en-US')).toBe('/about');
    expect(localeHref('/', 'en-US')).toBe('/');
    expect(localeHref('/foo/bar', 'en-US')).toBe('/foo/bar');
  });

  it('prepends the locale prefix for a non-default locale', () => {
    expect(localeHref('/about', 'es')).toBe('/es/about');
    expect(localeHref('/foo/bar', 'es')).toBe('/es/foo/bar');
  });

  it('emits /<locale> (no trailing slash) for the home path', () => {
    expect(localeHref('/', 'es')).toBe('/es');
  });

  it('handles paths without a leading slash', () => {
    expect(localeHref('about', 'es')).toBe('/es/about');
  });
});

describe('stripLocalePrefix', () => {
  it('returns the path unchanged for the default locale', () => {
    expect(stripLocalePrefix('/about', 'en-US')).toBe('/about');
    expect(stripLocalePrefix('/es/about', 'en-US')).toBe('/es/about');
  });

  it('strips the prefix for a non-default locale', () => {
    expect(stripLocalePrefix('/es/about', 'es')).toBe('/about');
    expect(stripLocalePrefix('/es/foo/bar', 'es')).toBe('/foo/bar');
  });

  it('returns / when path is exactly the locale prefix', () => {
    expect(stripLocalePrefix('/es', 'es')).toBe('/');
  });

  it('does not match a prefix that is part of a longer segment', () => {
    expect(stripLocalePrefix('/espoo', 'es')).toBe('/espoo');
  });

  it('round-trips with localeHref', () => {
    for (const path of ['/', '/about', '/foo/bar/baz', '/help']) {
      for (const locale of SUPPORTED_LOCALES) {
        expect(stripLocalePrefix(localeHref(path, locale), locale)).toBe(path);
      }
    }
  });
});

describe('detectLocale', () => {
  it('returns the default locale and no rewrite for unprefixed paths', () => {
    expect(detectLocale('/')).toEqual({
      locale: DEFAULT_LOCALE,
      strippedPath: '/',
      needsRewrite: false,
    });
    expect(detectLocale('/about')).toEqual({
      locale: DEFAULT_LOCALE,
      strippedPath: '/about',
      needsRewrite: false,
    });
    expect(detectLocale('/b/kilter-board/40/list')).toEqual({
      locale: DEFAULT_LOCALE,
      strippedPath: '/b/kilter-board/40/list',
      needsRewrite: false,
    });
  });

  it('detects /es and rewrites to /', () => {
    expect(detectLocale('/es')).toEqual({
      locale: 'es',
      strippedPath: '/',
      needsRewrite: true,
    });
  });

  it('detects /es/<path> and strips the prefix', () => {
    expect(detectLocale('/es/about')).toEqual({
      locale: 'es',
      strippedPath: '/about',
      needsRewrite: true,
    });
    expect(detectLocale('/es/help/foo')).toEqual({
      locale: 'es',
      strippedPath: '/help/foo',
      needsRewrite: true,
    });
  });

  it('does not match unrelated paths starting with the locale string', () => {
    // /espoo is not a Spanish-prefixed route; must not be rewritten.
    expect(detectLocale('/espoo')).toEqual({
      locale: DEFAULT_LOCALE,
      strippedPath: '/espoo',
      needsRewrite: false,
    });
  });
});
