/**
 * Invariants for `next.config.mjs`'s `redirects()`.
 *
 * Two rules are load-bearing for the web reposition (#4358) and neither is
 * visible from a single rule in isolation:
 *
 *  1. **Locale twins.** `redirects()` runs before `middleware.ts`, and its
 *     sources are matched literally against the incoming path. This repo has no
 *     Next i18n routing — locales are a middleware prefix — so `source: '/x'`
 *     never matches `/es/x`. A rule without its three twins silently 404s three
 *     quarters of the audience.
 *  2. **`permanent: false` for cross-origin destinations.** A permanent
 *     cross-origin redirect is browser-cached indefinitely and served CDN-stale
 *     by `middleware.ts` for `stale-while-revalidate = TTL × 7`. Until the app
 *     route is proven in production, every hop to `app.boardsesh.com` must stay
 *     recoverable.
 */
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_APP_ORIGIN } from '@boardsesh/shared-schema/app-origins';

type Redirect = { source: string; destination: string; permanent: boolean };
type NextConfigWithRedirects = { redirects?: () => Promise<Redirect[]> };

const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfigWithRedirects;
const redirects = (await nextConfig.redirects?.()) ?? [];

const LOCALE_PREFIXES = ['/es', '/fr', '/de'];

function isLocalePrefixed(source: string): boolean {
  return LOCALE_PREFIXES.some((prefix) => source === prefix || source.startsWith(`${prefix}/`));
}

function isCrossOrigin(destination: string): boolean {
  return destination.startsWith('http://') || destination.startsWith('https://');
}

const baseRedirects = redirects.filter((redirect) => !isLocalePrefixed(redirect.source));

describe('next.config redirects', () => {
  it('ships redirect rules at all', () => {
    expect(baseRedirects.length).toBeGreaterThan(0);
  });

  it('gives every rule an /es, /fr and /de twin', () => {
    const sources = new Set(redirects.map((redirect) => redirect.source));
    const missing = baseRedirects.flatMap((redirect) =>
      LOCALE_PREFIXES.filter((prefix) => !sources.has(`${prefix}${redirect.source}`)).map(
        (prefix) => `${prefix}${redirect.source}`,
      ),
    );

    expect(missing).toEqual([]);
  });

  it('keeps the reader in their locale on same-origin twins', () => {
    for (const redirect of baseRedirects) {
      if (isCrossOrigin(redirect.destination)) continue;

      for (const prefix of LOCALE_PREFIXES) {
        const twin = redirects.find((candidate) => candidate.source === `${prefix}${redirect.source}`);
        expect(twin?.destination, `${prefix}${redirect.source}`).toBe(`${prefix}${redirect.destination}`);
      }
    }
  });

  it('sends every locale twin of a cross-origin rule to the same app URL', () => {
    // The Expo app has no /es, /fr or /de routing — the same accepted
    // regression `buildAppHandoffUrl` records for the "Climb this" CTA.
    for (const redirect of baseRedirects) {
      if (!isCrossOrigin(redirect.destination)) continue;

      for (const prefix of LOCALE_PREFIXES) {
        const twin = redirects.find((candidate) => candidate.source === `${prefix}${redirect.source}`);
        expect(twin?.destination, `${prefix}${redirect.source}`).toBe(redirect.destination);
      }
    }
  });

  it('never makes a cross-origin redirect permanent', () => {
    const permanentCrossOrigin = redirects.filter(
      (redirect) => isCrossOrigin(redirect.destination) && redirect.permanent,
    );

    expect(permanentCrossOrigin).toEqual([]);
  });

  it('makes every same-origin redirect permanent', () => {
    const temporarySameOrigin = redirects.filter(
      (redirect) => !isCrossOrigin(redirect.destination) && !redirect.permanent,
    );

    expect(temporarySameOrigin).toEqual([]);
  });

  it('pins the config app origin to the shared default', () => {
    expect(configModule.APP_ORIGIN).toBe(DEFAULT_APP_ORIGIN);
  });

  it('30x-es every board-route sibling W-17 deleted, on both trees', () => {
    const canonical = '/:board/:layout/:size/:set/:angle';
    const slugTree = '/b/:board_slug/:angle';
    const expectedSources = [
      `${canonical}/create`,
      `${canonical}/import`,
      `${canonical}/liked`,
      `${canonical}/logbook`,
      `${canonical}/playlists`,
      `${canonical}/playlists/:uuid`,
      `${slugTree}/create`,
      `${slugTree}/import`,
      `${slugTree}/liked`,
      `${slugTree}/logbook`,
      `${slugTree}/playlists`,
      `${slugTree}/playlists/:uuid`,
    ];

    const sources = new Set(baseRedirects.map((redirect) => redirect.source));
    expect(expectedSources.filter((source) => !sources.has(source))).toEqual([]);
  });

  it('points both create rules at the app, temporarily', () => {
    const createRules = baseRedirects.filter((redirect) => redirect.source.endsWith('/create'));

    expect(createRules).toHaveLength(2);
    for (const rule of createRules) {
      expect(rule.destination).toBe(`${DEFAULT_APP_ORIGIN}/climbs/create`);
      expect(rule.permanent).toBe(false);
    }
  });

  it('keeps the liked redirect on the board it named', () => {
    const likedRules = baseRedirects.filter((redirect) => redirect.source.endsWith('/liked'));

    expect(likedRules.map((rule) => rule.destination)).toEqual([
      '/:board/:layout/:size/:set/:angle/list',
      '/b/:board_slug/:angle/list',
    ]);
  });

  it('re-homes both import routes onto the board-agnostic importer', () => {
    const importRules = baseRedirects.filter((redirect) => redirect.source.endsWith('/import'));

    expect(importRules).toHaveLength(2);
    for (const rule of importRules) {
      expect(rule.destination.startsWith('/moonboard-import')).toBe(true);
      expect(rule.permanent).toBe(true);
    }
  });

  it('leaves the /play routes alone — their pages redirect with the climb name', () => {
    // A static rule here would emit a bare-uuid /view URL that redirects again,
    // turning one hop into two.
    expect(redirects.some((redirect) => /\/play(\/|$)/.test(redirect.source))).toBe(false);
  });
});
