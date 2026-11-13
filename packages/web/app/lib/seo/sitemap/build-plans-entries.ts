import 'server-only';
import type { SitemapItem } from './entries';

// Both public CNC routes remain noindex pending the manufacturing licence review.
// Enabling the access flag does not make either route indexable.
export const BUILD_PLANS_ENTRIES: readonly SitemapItem[] = [];

export async function buildBuildPlansEntries(): Promise<SitemapItem[]> {
  return [...BUILD_PLANS_ENTRIES];
}
