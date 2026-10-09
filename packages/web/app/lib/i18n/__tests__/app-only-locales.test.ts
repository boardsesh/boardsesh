import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vite-plus/test';
import { APP_ONLY_LOCALES, WEB_LOCALES, SUPPORTED_LOCALES as APP_LOCALES } from '@boardsesh/i18n';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_HEADER, SUPPORTED_LOCALES, isSupportedLocale } from '../config';
import { detectLocale } from '../detect-locale';
import { buildAlternates, expandLocales } from '@/app/lib/seo/sitemap/entries';
import { createPageMetadata } from '@/app/lib/seo/metadata';

const { middleware } = await import('@/middleware');

// The mobile app runs in locales www does not serve. Simplified Chinese ships
// the twelve mobile namespaces and no marketing, gyms, kiosk or admin catalog,
// so a /zh-Hans page would render English under a Chinese hreflang. Everything
// here proves the app-only list stays out of the web's routing and SEO.

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('app-only locales stay off www', () => {
  it('has an app-only locale to guard against', () => {
    expect([...APP_ONLY_LOCALES]).toContain('zh-Hans');
    expect([...APP_LOCALES]).toContain('zh-Hans');
  });

  it('exposes the web list, not the app list, as the web SUPPORTED_LOCALES', () => {
    expect([...SUPPORTED_LOCALES]).toEqual([...WEB_LOCALES]);
    expect([...SUPPORTED_LOCALES]).toEqual(['en-US', 'es', 'fr', 'de']);
  });

  it.each([...APP_ONLY_LOCALES])('%s is not a web locale', (locale) => {
    expect((SUPPORTED_LOCALES as readonly string[]).includes(locale)).toBe(false);
    expect(isSupportedLocale(locale)).toBe(false);
  });

  it.each([...APP_ONLY_LOCALES])('/%s is not detected as a locale prefix', (locale) => {
    // No rewrite means the request falls through to the route tree as written,
    // where no page matches `/zh-Hans`, so Next answers 404.
    expect(detectLocale(`/${locale}`)).toEqual({
      locale: DEFAULT_LOCALE,
      strippedPath: `/${locale}`,
      needsRewrite: false,
    });
    expect(detectLocale(`/${locale}/about`)).toEqual({
      locale: DEFAULT_LOCALE,
      strippedPath: `/${locale}/about`,
      needsRewrite: false,
    });
  });

  it.each([...APP_ONLY_LOCALES])('the middleware does not rewrite /%s to an English page', (locale) => {
    for (const path of [`/${locale}`, `/${locale}/about`, `/${locale}/gyms`]) {
      const response = middleware(new NextRequest(`http://localhost:3000${path}`));
      expect({ path, rewritten: response.headers.has('x-middleware-rewrite') }).toEqual({ path, rewritten: false });
      expect(response.headers.get(`x-middleware-request-${LOCALE_HEADER}`)).toBe(DEFAULT_LOCALE);
    }
  });

  it.each([...APP_ONLY_LOCALES])('a %s locale cookie does not redirect to a prefixed URL', (locale) => {
    const response = middleware(
      new NextRequest('http://localhost:3000/about', { headers: { cookie: `${LOCALE_COOKIE}=${locale}` } }),
    );
    expect(response.headers.get('location')).toBeNull();
  });

  it('emits no sitemap row or hreflang alternate for an app-only locale', () => {
    const alternates = buildAlternates('/playlists/abc');
    const sitemapUrls = expandLocales({ path: '/playlists/abc' }).map((entry) => entry.loc);
    const languages = createPageMetadata({ title: 'About', description: 'About Boardsesh', path: '/about' }).alternates
      ?.languages;

    expect(Object.keys(alternates).sort()).toEqual(['de', 'en-US', 'es', 'fr', 'x-default']);
    expect(Object.keys(languages ?? {}).sort()).toEqual(['de', 'en-US', 'es', 'fr', 'x-default']);
    expect(sitemapUrls).toHaveLength(WEB_LOCALES.length);
    for (const locale of APP_ONLY_LOCALES) {
      expect(sitemapUrls.some((url) => url.includes(`/${locale}`))).toBe(false);
      expect(JSON.stringify(alternates)).not.toContain(locale);
      expect(JSON.stringify(languages)).not.toContain(locale);
    }
  });
});

describe('web source reads the web locale list', () => {
  // The shared package's SUPPORTED_LOCALES / Locale / isSupportedLocale include
  // app-only locales. One web file importing them directly would put zh-Hans in
  // a route table, the language switcher or a sitemap with every test above
  // still green for the files it did not touch. Web goes through
  // `app/lib/i18n/config`, which re-exports the web list under those names.
  const APP_WIDE_NAMES = /\b(SUPPORTED_LOCALES|APP_ONLY_LOCALES|isSupportedLocale|Locale)\b/;
  const SHARED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@boardsesh\/i18n'/g;

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      if (name === 'node_modules' || name === '.next' || name === '__tests__') return [];
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('never imports the app-wide locale list from @boardsesh/i18n', () => {
    const files = [...sourceFiles(join(WEB_ROOT, 'app')), join(WEB_ROOT, 'middleware.ts')];
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(SHARED_IMPORT)]
        .flatMap((match) => match[1].split(','))
        // `WEB_LOCALES as SUPPORTED_LOCALES` is the sanctioned alias: judge the
        // imported name, not the local one.
        .map((specifier) =>
          specifier
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter((imported) => APP_WIDE_NAMES.test(imported))
        .map((imported) => `${relative(WEB_ROOT, file)}: ${imported}`),
    );
    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
