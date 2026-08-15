import { shardRouteHandler } from '@/app/lib/seo/sitemap/shard-registry';

// Kept out of the build-time prerender pass for the same reason as the index:
// the shard builders read the database and the GraphQL backend at request time.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return shardRouteHandler('setters');
}
