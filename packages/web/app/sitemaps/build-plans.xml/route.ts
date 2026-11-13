import { shardRouteHandler } from '@/app/lib/seo/sitemap/shard-registry';

// Kept out of the build-time prerender pass for the same reason as the index:
// the shard builders read at request time — this one reads the `cnc-packs`
// feature flag, whose whole point is that flipping it in PostHog publishes the
// URLs without a deploy.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return shardRouteHandler('build-plans');
}
