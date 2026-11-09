import { describe, it, expect } from 'vite-plus/test';
import { GET } from '@/app/.well-known/apple-app-site-association/route';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { boardQrUrl, gymQrUrl } from '@/app/lib/gym-attribution';
import {
  APPLE_APP_ID,
  buildAppleAppSiteAssociation,
  buildAppleAppSiteAssociationPaths,
} from '../apple-app-site-association';

/**
 * Apple's matching rules for the `paths` array, as documented for the
 * association file: patterns are tried in order and the first match decides;
 * `*` matches any run of characters (slashes included), `?` matches exactly
 * one; a `NOT ` prefix turns a match into "leave this in the browser". Only the
 * path is matched, never the query string or fragment. Matching is
 * case-sensitive.
 *
 * Asserting through this instead of `toContain('NOT /gym/*')` is the point: an
 * exclusion that is present but sits below `/*` is in the array and does
 * nothing.
 */
function opensInApp(paths: readonly string[], url: string): boolean {
  const { pathname } = new URL(url, 'https://www.boardsesh.com');
  for (const entry of paths) {
    const isExclusion = entry.startsWith('NOT ');
    const pattern = isExclusion ? entry.slice('NOT '.length) : entry;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    if (matcher.test(pathname)) return !isExclusion;
  }
  return false;
}

const nonDefaultLocales = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

describe('apple-app-site-association paths', () => {
  const paths = buildAppleAppSiteAssociationPaths();

  it('ends with the catch-all, and every exclusion sits above it', () => {
    expect(paths.at(-1)).toBe('/*');
    expect(paths.slice(0, -1).every((entry) => entry.startsWith('NOT '))).toBe(true);
  });

  it('keeps a scanned gym poster in the browser', () => {
    // The exact string the poster prints, query and all.
    expect(opensInApp(paths, gymQrUrl('power-up-alabang', 'poster'))).toBe(false);
  });

  it('keeps the gym page, its poster and its manage console in the browser', () => {
    expect(opensInApp(paths, '/gym/bloclab')).toBe(false);
    expect(opensInApp(paths, '/gym/bloclab/poster')).toBe(false);
    expect(opensInApp(paths, '/gym/bloclab/manage')).toBe(false);
    // The manage console resolves a uuid as well as a slug.
    expect(opensInApp(paths, '/gym/0b5c2c0e-6d0a-4a55-9a0f-0d9f3f0a7c11/manage')).toBe(false);
  });

  it('keeps locale-prefixed gym pages in the browser too', () => {
    expect(nonDefaultLocales.length).toBeGreaterThan(0);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/gym/bloclab`)).toBe(false);
      expect(opensInApp(paths, `/${locale}/gym/bloclab/poster`)).toBe(false);
      expect(opensInApp(paths, `/${locale}/gym/bloclab/manage`)).toBe(false);
    }
  });

  it('keeps the board poster print page in the browser, with or without locale', () => {
    expect(opensInApp(paths, '/poster/b/home-wall')).toBe(false);
    expect(opensInApp(paths, '/poster/b/home-wall?wall=abc')).toBe(false);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/poster/b/x`)).toBe(false);
    }
  });

  it('keeps partner app consent and sign-in in the browser, with or without locale', () => {
    expect(opensInApp(paths, '/oauth/consent')).toBe(false);
    // The consent link carries the signed query the backend issues.
    expect(opensInApp(paths, '/oauth/consent?client_id=abc&sig=def&exp=1')).toBe(false);
    expect(opensInApp(paths, '/oauth/sign-in')).toBe(false);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/oauth/consent`)).toBe(false);
      expect(opensInApp(paths, `/${locale}/oauth/sign-in`)).toBe(false);
    }
  });

  it('keeps the developer console in the browser, with or without locale', () => {
    expect(opensInApp(paths, '/developers/apps')).toBe(false);
    expect(opensInApp(paths, '/developers/apps/new')).toBe(false);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/developers/apps`)).toBe(false);
    }
  });

  it('keeps the bare /developers overview in the browser, with or without locale', () => {
    // `NOT /developers/*` needs the slash, so this page needs its own entry.
    expect(opensInApp(paths, '/developers')).toBe(false);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/developers`)).toBe(false);
    }
  });

  it('keeps the NextAuth error page in the browser, with or without locale', () => {
    expect(opensInApp(paths, '/auth/error?error=Configuration')).toBe(false);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/auth/error`)).toBe(false);
    }
  });

  it('still opens the login link the verify-email redirect sends in the app', () => {
    expect(opensInApp(paths, '/auth/login?verified=true')).toBe(true);
  });

  it('still opens the board link the poster QR prints in the app', () => {
    // The URL `boardQrUrl` builds for a board poster, query and all.
    expect(opensInApp(paths, boardQrUrl('home-wall', 'board'))).toBe(true);
    expect(opensInApp(paths, '/b/home-wall?wall=abc&src=qr&medium=board')).toBe(true);
  });

  it('still opens the gym directory in the app, which has that screen', () => {
    expect(opensInApp(paths, '/gyms')).toBe(true);
    expect(opensInApp(paths, '/gyms/mine')).toBe(true);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/gyms`)).toBe(true);
    }
  });

  it('still opens session, board and climb links in the app', () => {
    expect(opensInApp(paths, '/join/5d3b1c7e-2a4f-4f0e-9d53-6f1a2b3c4d5e')).toBe(true);
    expect(opensInApp(paths, '/b/home-wall/40/list')).toBe(true);
    expect(opensInApp(paths, '/kilter/original/12x12/bolt-ons/40/view/some-climb')).toBe(true);
    expect(opensInApp(paths, '/es/kilter/original/12x12/bolt-ons/40/view/some-climb')).toBe(true);
    expect(opensInApp(paths, '/')).toBe(true);
  });

  it('opens shared playlist and setter links in the app, which has those screens', () => {
    expect(opensInApp(paths, '/playlists/5d3b1c7e-2a4f-4f0e-9d53-6f1a2b3c4d5e')).toBe(true);
    expect(opensInApp(paths, '/setter/jimmy%20webb')).toBe(true);
    for (const locale of nonDefaultLocales) {
      expect(opensInApp(paths, `/${locale}/playlists/5d3b1c7e-2a4f-4f0e-9d53-6f1a2b3c4d5e`)).toBe(true);
      expect(opensInApp(paths, `/${locale}/setter/jimmy%20webb`)).toBe(true);
    }
  });

  it('keeps the infrastructure exclusions it already had', () => {
    expect(opensInApp(paths, '/api/v1/kilter/grades')).toBe(false);
    expect(opensInApp(paths, '/_next/static/chunks/main.js')).toBe(false);
    expect(opensInApp(paths, '/monitoring')).toBe(false);
    expect(opensInApp(paths, '/.well-known/assetlinks.json')).toBe(false);
  });

  it('pins the full list, so a reorder or a dropped entry is a visible diff', () => {
    expect(paths).toEqual([
      'NOT /api/*',
      'NOT /_next/*',
      'NOT /monitoring',
      'NOT /.well-known/*',
      'NOT /gym/*',
      'NOT /es/gym/*',
      'NOT /fr/gym/*',
      'NOT /de/gym/*',
      'NOT /it/gym/*',
      'NOT /poster/*',
      'NOT /es/poster/*',
      'NOT /fr/poster/*',
      'NOT /de/poster/*',
      'NOT /it/poster/*',
      'NOT /oauth/*',
      'NOT /es/oauth/*',
      'NOT /fr/oauth/*',
      'NOT /de/oauth/*',
      'NOT /it/oauth/*',
      'NOT /developers/*',
      'NOT /es/developers/*',
      'NOT /fr/developers/*',
      'NOT /de/developers/*',
      'NOT /it/developers/*',
      'NOT /developers',
      'NOT /es/developers',
      'NOT /fr/developers',
      'NOT /de/developers',
      'NOT /it/developers',
      'NOT /auth/error',
      'NOT /es/auth/error',
      'NOT /fr/auth/error',
      'NOT /de/auth/error',
      'NOT /it/auth/error',
      '/*',
    ]);
  });
});

describe('GET /.well-known/apple-app-site-association', () => {
  it('serves the built document as JSON for the Boardsesh app id', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const body = (await response.json()) as ReturnType<typeof buildAppleAppSiteAssociation>;
    expect(body).toEqual(buildAppleAppSiteAssociation());
    expect(body).toMatchObject({ applinks: { details: [{ appID: APPLE_APP_ID }] } });
    expect(body.applinks.details[0].paths).toEqual(buildAppleAppSiteAssociationPaths());
  });
});
