#!/usr/bin/env tsx
/**
 * The App Store figure on the app guide pages: every storefront's public rating
 * for Boardsesh, added up.
 *
 *   vp run app-guides:rating
 *
 * Calls Apple's public lookup (`https://itunes.apple.com/lookup?id=…&country=…`)
 * once per storefront, about 300 ms apart, sums `userRatingCount` and takes the
 * count-weighted mean of `averageUserRating`. Prints the JSON that goes into
 * `BOARDSESH_APP_STORE_RATING` (`packages/web/app/lib/seo/app-guides.ts`). Anyone
 * can repeat it, which is the point: App Store Connect can be a rating or two
 * ahead of the lookup's cache, and the page shows the public figure.
 */
import { pathToFileURL } from 'node:url';

export const APP_STORE_ID = '6761350784';

/** Apple App Store storefronts, by ISO country code. */
export const APP_STORE_STOREFRONTS = [
  'ae',
  'ag',
  'ai',
  'al',
  'am',
  'ao',
  'ar',
  'at',
  'au',
  'az',
  'ba',
  'bb',
  'be',
  'bf',
  'bg',
  'bh',
  'bj',
  'bm',
  'bn',
  'bo',
  'br',
  'bs',
  'bt',
  'bw',
  'by',
  'bz',
  'ca',
  'cd',
  'cg',
  'ch',
  'ci',
  'cl',
  'cm',
  'cn',
  'co',
  'cr',
  'cv',
  'cy',
  'cz',
  'de',
  'dk',
  'dm',
  'do',
  'dz',
  'ec',
  'ee',
  'eg',
  'es',
  'fi',
  'fj',
  'fm',
  'fr',
  'ga',
  'gb',
  'gd',
  'ge',
  'gh',
  'gm',
  'gr',
  'gt',
  'gw',
  'gy',
  'hk',
  'hn',
  'hr',
  'hu',
  'id',
  'ie',
  'il',
  'in',
  'iq',
  'is',
  'it',
  'jm',
  'jo',
  'jp',
  'ke',
  'kg',
  'kh',
  'kn',
  'kr',
  'kw',
  'ky',
  'kz',
  'la',
  'lb',
  'lc',
  'lk',
  'lr',
  'lt',
  'lu',
  'lv',
  'ly',
  'ma',
  'md',
  'me',
  'mg',
  'mk',
  'ml',
  'mm',
  'mn',
  'mo',
  'mr',
  'ms',
  'mt',
  'mu',
  'mv',
  'mw',
  'mx',
  'my',
  'mz',
  'na',
  'ne',
  'ng',
  'ni',
  'nl',
  'no',
  'np',
  'nr',
  'nz',
  'om',
  'pa',
  'pe',
  'pg',
  'ph',
  'pk',
  'pl',
  'pt',
  'pw',
  'py',
  'qa',
  'ro',
  'rs',
  'ru',
  'rw',
  'sa',
  'sb',
  'sc',
  'se',
  'sg',
  'si',
  'sk',
  'sl',
  'sn',
  'sr',
  'st',
  'sv',
  'sz',
  'tc',
  'td',
  'th',
  'tj',
  'tm',
  'tn',
  'to',
  'tr',
  'tt',
  'tw',
  'tz',
  'ua',
  'ug',
  'us',
  'uy',
  'uz',
  'vc',
  've',
  'vg',
  'vn',
  'vu',
  'xk',
  'ye',
  'za',
  'zm',
  'zw',
] as const;

export type StorefrontRating = { country: string; rating: number; count: number };

/** Storefronts with ratings, their total count and the count-weighted mean (3 decimals). */
export function aggregateRatings(perCountry: readonly StorefrontRating[]) {
  const rated = perCountry.filter((entry) => entry.count > 0);
  const count = rated.reduce((total, entry) => total + entry.count, 0);
  const weighted = rated.reduce((total, entry) => total + entry.rating * entry.count, 0);
  return {
    rating: count === 0 ? 0 : Math.round((weighted / count) * 1000) / 1000,
    count,
    storefronts: rated.length,
  };
}

async function lookup(country: string): Promise<StorefrontRating> {
  const response = await fetch(`https://itunes.apple.com/lookup?id=${APP_STORE_ID}&country=${country}`);
  if (!response.ok) throw new Error(`${country}: HTTP ${response.status}`);
  const body = (await response.json()) as { results?: { averageUserRating?: number; userRatingCount?: number }[] };
  const result = body.results?.[0];
  return { country, rating: result?.averageUserRating ?? 0, count: result?.userRatingCount ?? 0 };
}

async function main() {
  const perCountry: StorefrontRating[] = [];
  for (const country of APP_STORE_STOREFRONTS) {
    perCountry.push(await lookup(country));
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const checkedAt = new Date().toISOString().slice(0, 10);
  const rated = perCountry.filter((entry) => entry.count > 0).sort((a, b) => b.count - a.count);
  console.log(JSON.stringify({ ...aggregateRatings(perCountry), checkedAt, perCountry: rated }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
