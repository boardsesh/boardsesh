import 'server-only';
import { CNC_PACKS_FLAG } from '@/app/flags';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import type { SitemapItem } from './entries';

/**
 * The `/build-plans` shard: the shop's own indexable pages.
 *
 * A search surface, not a utility one — people look for "kilter homewall CNC
 * plans" and "climbing wall panel DXF" — so the pages are translated content
 * that fans out to all four locales like `/about` and `/legal` do, and the
 * shard takes the registry's default `all-locales` expansion.
 *
 * Hardcoded dates, same convention as `static-entries.ts`: bump the date when
 * the copy actually changes rather than letting `new Date()` claim a fresh edit
 * on every crawl.
 *
 * `/build-plans/orders` and `/build-plans/orders/[licenceId]` are deliberately
 * absent. They are per-buyer utility pages behind a login, they carry a licence
 * id in the URL, and listing them would ask Google to crawl a surface it can
 * only ever be redirected away from.
 *
 * `/build-plans/licence` belongs here too and is not listed yet, because the
 * page does not exist yet — the manufacturing licence ships marked DRAFT and
 * its own PR has not landed. Add it in the PR that adds the route; the guard
 * test beside this file fails on any path here without a `page.tsx` behind it,
 * so the list cannot start advertising a 404.
 */
export const BUILD_PLANS_ENTRIES: readonly SitemapItem[] = [
  { path: '/build-plans', changeFrequency: 'monthly', priority: 0.7, lastModified: new Date('2026-09-06') },
];

/**
 * The shard's items — empty while `cnc-packs` is off.
 *
 * The shard is declared `expectsUrls: false` precisely so this can answer
 * nothing without 503ing: before launch there is no shop, so an empty
 * `<urlset>` is the truth rather than a regressed builder. That is also why the
 * gate is here and not a hardcoded list edit at launch — the flag flip alone
 * publishes the URLs, with no deploy and no second thing to remember.
 *
 * `allowAnonymous: true` is load-bearing for exactly the reason it is on the
 * pages: a crawler is nobody, so without the opt-in this resolves
 * `no-distinct-id` and the shard would stay empty however the PostHog rollout
 * is set. Fails closed like every other flag read — an unreachable PostHog
 * withholds the URLs rather than publishing a surface that 404s.
 */
export async function buildBuildPlansEntries(): Promise<SitemapItem[]> {
  const enabled = await getServerFeatureFlag(CNC_PACKS_FLAG, { distinctId: null, allowAnonymous: true });
  return enabled ? [...BUILD_PLANS_ENTRIES] : [];
}
