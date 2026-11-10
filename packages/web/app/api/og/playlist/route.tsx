import type { NextRequest } from 'next/server';
import { redirectToOgFamilyCard } from '@/app/lib/seo/og-family-redirect';

export const runtime = 'nodejs';

/**
 * Legacy og:image URL, kept so links shared before the card moved to the
 * backend still unfurl: a 307 to `/og/playlist` on the backend origin.
 */
export function GET(request: NextRequest): Response {
  return redirectToOgFamilyCard(request, 'playlist', 'uuid');
}
