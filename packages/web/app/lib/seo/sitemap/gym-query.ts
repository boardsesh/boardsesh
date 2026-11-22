import 'server-only';
import { PUBLIC_GYM_SITEMAP, type PublicGymSitemapQueryResponse } from '@boardsesh/graphql/operations';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';

/** Recheck visibility on each build so unlisting withdraws a venue immediately. */
export async function fetchGymSitemapRows() {
  const response = await executeGraphQLInternal<PublicGymSitemapQueryResponse>(
    PUBLIC_GYM_SITEMAP,
    undefined,
    AbortSignal.timeout(2_500),
  );
  return response.publicGymSitemap;
}
