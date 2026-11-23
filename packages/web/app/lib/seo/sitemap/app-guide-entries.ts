import { APP_GUIDE_COMPARISON, APP_GUIDE_HUB, APP_GUIDES } from '@/app/lib/seo/app-guides';
import type { SitemapItem } from './entries';

export function buildAppGuideEntries(): SitemapItem[] {
  return [APP_GUIDE_HUB, ...APP_GUIDES, APP_GUIDE_COMPARISON].map(({ path, updatedAt }) => ({
    path,
    lastModified: new Date(updatedAt),
  }));
}
