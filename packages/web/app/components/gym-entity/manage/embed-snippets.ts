// Pure builders for the iframe snippets gym owners paste into their own
// websites. The URLs are uuid-keyed on purpose: board slugs are user-editable
// and gym slugs are nullable + editable, so a slug-keyed snippet pasted into a
// CMS would break on rename; uuids never move.

import {
  buildBoardEmbedSnippet as buildSharedBoardEmbedSnippet,
  buildLeaderboardEmbedSnippet as buildSharedLeaderboardEmbedSnippet,
  type BoardEmbedSnippetOptions,
  type LeaderboardEmbedSnippetOptions,
} from '@boardsesh/kiosk';
import { SITE_URL } from '@/app/lib/seo/base-url';

export { escapeHtmlAttribute } from '@boardsesh/kiosk';

/** Iframe snippet for the live board view at /embed/board/{boardUuid}. */
export function buildBoardEmbedSnippet(options: Omit<BoardEmbedSnippetOptions, 'siteOrigin'>): string {
  return buildSharedBoardEmbedSnippet({ ...options, siteOrigin: SITE_URL });
}

/**
 * Iframe snippet for the gym leaderboard at /embed/gym/{gymUuid}/leaderboard.
 * Defaults to the weekly window; the period query param also accepts day|month
 * (the embed dialog surfaces that note next to the snippet).
 */
export function buildLeaderboardEmbedSnippet(options: Omit<LeaderboardEmbedSnippetOptions, 'siteOrigin'>): string {
  return buildSharedLeaderboardEmbedSnippet({ ...options, siteOrigin: SITE_URL });
}
