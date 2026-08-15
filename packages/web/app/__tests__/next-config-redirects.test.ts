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
 *     cross-origin redirect is cached by the browser indefinitely, and there is
 *     no server-side hatch to take it back. Until the app route is proven in
 *     production, every hop to `app.boardsesh.com` must stay recoverable.
 *  3. **Order.** Next matches these in array order, so the MoonBoard-specific
 *     `/import` rule has to come before the `/:board/…` catch-all.
 */
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_APP_ORIGIN } from '@boardsesh/shared-schema/app-origins';

type Redirect = { source: string; destination: string; permanent: boolean };
type NextConfigWithRedirects = { redirects?: () => Promise<Redirect[]> };

const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfigWithRedirects;
const redirects = (await nextConfig.redirects?.()) ?? [];

/**
 * The origin the rules were actually built with. `next.config.mjs` lets
 * `NEXT_PUBLIC_APP_URL` override the default — `.env.local` recommends
 * `http://localhost:8081` for local Expo-web work — so assertions about the
 * emitted destinations read this, and the separate `DEFAULT_CONFIG_APP_ORIGIN`
 * export is what gets pinned against the shared literal.
 */
const configuredAppOrigin = configModule.APP_ORIGIN;

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

  it('pins the config app origin default to the shared literal', () => {
    expect(configModule.DEFAULT_CONFIG_APP_ORIGIN).toBe(DEFAULT_APP_ORIGIN);
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

  it('collapses the deleted /you logbook tab back onto /you', () => {
    const rule = baseRedirects.find((redirect) => redirect.source === '/you/logbook');
    expect(rule).toBeDefined();
    expect(rule?.destination).toBe('/you');
    expect(rule?.permanent).toBe(true);
  });

  it('points every create rule at the app, temporarily', () => {
    const createRules = baseRedirects.filter((redirect) => redirect.source.endsWith('/create'));

    expect(createRules).toHaveLength(3);
    for (const rule of createRules) {
      expect(rule.destination.startsWith(`${configuredAppOrigin}/climbs/create`)).toBe(true);
      expect(rule.permanent).toBe(false);
    }
  });

  it('hands the app the board a canonical numeric create URL named', () => {
    // These are the params `packages/mobile/app/(tabs)/climbs/create.tsx` reads.
    // Dropping them would open the editor on whatever board the app last had.
    const [numericRule] = baseRedirects.filter((redirect) => redirect.source.endsWith('/create'));

    expect(numericRule.source).toBe('/:board/:layout(\\d+)/:size(\\d+)/:set([\\d,]+)/:angle(\\d+)/create');
    expect(numericRule.destination).toBe(
      `${configuredAppOrigin}/climbs/create?boardName=:board&layoutId=:layout&sizeId=:size&setIds=:set&angle=:angle`,
    );
  });

  it('hands over bare from the slug forms, which the app cannot parse', () => {
    // `Number('original')` is NaN, and resolving a slug needs a DB lookup a
    // static redirect cannot do — the app's active-board fallback is better.
    const slugCreateRules = baseRedirects.filter(
      (redirect) => redirect.source.endsWith('/create') && !redirect.source.includes('\\d'),
    );

    expect(slugCreateRules.map((rule) => rule.source)).toEqual([
      '/:board/:layout/:size/:set/:angle/create',
      '/b/:board_slug/:angle/create',
    ]);
    for (const rule of slugCreateRules) {
      expect(rule.destination).toBe(`${configuredAppOrigin}/climbs/create`);
    }
  });

  it('keeps the liked redirect on the board it named', () => {
    const likedRules = baseRedirects.filter((redirect) => redirect.source.endsWith('/liked'));

    expect(likedRules.map((rule) => rule.destination)).toEqual([
      '/:board/:layout/:size/:set/:angle/list',
      '/b/:board_slug/:angle/list',
    ]);
  });

  it('re-homes the MoonBoard import routes onto the board-agnostic importer', () => {
    const importRules = baseRedirects.filter((redirect) => redirect.source.endsWith('/import'));

    // Order is the whole point: the MoonBoard rule has to be matched before the
    // `/:board/…` catch-all, or `/kilter/1/…/import` renders the importer for
    // MoonBoard layout 1 (`MOONBOARD_LAYOUTS` ids 1–7 collide with Aurora's).
    expect(importRules.map((rule) => `${rule.source} -> ${rule.destination}`)).toEqual([
      '/moonboard/:layout/:size/:set/:angle/import -> /moonboard-import?layout=:layout&sets=:set&angle=:angle',
      '/:board/:layout/:size/:set/:angle/import -> /:board/:layout/:size/:set/:angle/list',
      '/b/:board_slug/:angle/import -> /moonboard-import?angle=:angle',
    ]);
    for (const rule of importRules) {
      expect(rule.permanent).toBe(true);
    }
  });

  it('carries the hold sets a MoonBoard import URL named', () => {
    // The deleted page drew only the sets the URL listed. Without `sets` the
    // importer stacks every set for the layout — six overlays on a 2024 wall.
    const moonBoardImportRule = baseRedirects.find((redirect) => redirect.source.startsWith('/moonboard/'));

    expect(moonBoardImportRule?.destination).toContain('sets=:set');
  });

  it('leaves the /play routes alone — their pages redirect with the climb name', () => {
    // A static rule here would emit a bare-uuid /view URL that redirects again,
    // turning one hop into two.
    expect(redirects.some((redirect) => /\/play(\/|$)/.test(redirect.source))).toBe(false);
  });
});
