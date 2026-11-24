import { shardRouteHandler } from '@/app/lib/seo/sitemap/shard-registry';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return shardRouteHandler('app-guides');
}
