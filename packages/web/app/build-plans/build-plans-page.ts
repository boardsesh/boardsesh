import 'server-only';
import { notFound } from 'next/navigation';
import { GET_CNC_CATALOG, type GetCncCatalogQueryResponse } from '@boardsesh/graphql/operations/cnc-packs';
import type { CncCatalog } from '@boardsesh/shared-schema';
import { CNC_PACKS_FLAG } from '@/app/flags';
import { getPosthogDistinctId } from '@/app/lib/feature-flags/server-distinct-id';
import { getServerFeatureFlag } from '@/app/lib/feature-flags/server-feature-flag';
import { createCachedGraphQLQuery } from '@/app/lib/graphql/server-cached-client';

/**
 * The one gate every `/build-plans*` route calls, and the one catalogue fetch
 * the public pages share.
 *
 * Both live here rather than being copy-pasted into four route files because
 * getting either wrong is silent: a page that forgets the flag is a publicly
 * reachable shop for a product whose licence is still marked DRAFT, and a page
 * that fetches the catalogue its own way is a second cache key for four rows of
 * static registry data.
 */

/**
 * 404 unless the `cnc-packs` flag is on for this visitor.
 *
 * `allowAnonymous: true` is load-bearing, not boilerplate. Build plans are
 * bought by people who have never signed in — the whole funnel starts with a
 * stranger reading the page — so without the opt-in the gate would resolve
 * `no-distinct-id` for every anonymous visitor and the surface would stay
 * signed-in-only however the PostHog rollout is configured (see the note on
 * `ServerFeatureFlagOptions.allowAnonymous`).
 *
 * `notFound()` rather than a redirect or a 403: while the flag is off this
 * surface does not exist, and a 403 would confirm to anyone poking at the URL
 * that it is about to.
 */
export async function requireCncPacksFlag(): Promise<void> {
  const distinctId = await getPosthogDistinctId();
  const enabled = await getServerFeatureFlag(CNC_PACKS_FLAG, { distinctId, allowAnonymous: true });
  if (!enabled) {
    notFound();
  }
}

/**
 * Sixty seconds.
 *
 * The catalogue is a hardcoded registry in the backend, so it only changes on a
 * deploy — but the prices on this page are the prices Stripe will charge, and a
 * long TTL means a price correction is visible to some visitors and not others
 * for as long as the TTL runs. A minute keeps that window shorter than the time
 * it takes to notice.
 */
const CATALOG_REVALIDATE_SECONDS = 60;

/**
 * Wall clock ceiling on the catalogue fetch. Without one a wedged backend hangs
 * the render instead of degrading it; the caller turns a rejection into the
 * outage state.
 */
const CATALOG_TIMEOUT_MS = 4_000;

const cachedCncCatalog = createCachedGraphQLQuery<GetCncCatalogQueryResponse>(
  GET_CNC_CATALOG,
  'cnc-catalog',
  CATALOG_REVALIDATE_SECONDS,
  CATALOG_TIMEOUT_MS,
);

/**
 * The catalogue, cached and unauthenticated.
 *
 * Cached rather than per-request (`executeGraphQL`) because `cncCatalog` is
 * public, identical for everyone, and the same four entries on every render —
 * exactly what the shared data cache is for. Returns null on failure so the
 * page can say the shop is having a moment instead of throwing a 500 at
 * somebody who came to spend money.
 */
export async function fetchCncCatalog(): Promise<CncCatalog | null> {
  try {
    const response = await cachedCncCatalog();
    return response.cncCatalog;
  } catch (error) {
    console.error('fetchCncCatalog failed:', error);
    return null;
  }
}
