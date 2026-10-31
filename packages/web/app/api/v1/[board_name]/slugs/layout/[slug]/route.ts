import { NextResponse } from 'next/server';
import { type LayoutRow, getLayoutBySlug } from '@/app/lib/slug-utils';
import { enforcePublicApiRateLimit } from '@/app/lib/public-api-rate-limit.server';
import type { BoardName } from '@/app/lib/types';

export async function GET(
  req: Request,
  props: { params: Promise<{ board_name: string; slug: string }> },
): Promise<NextResponse<LayoutRow | { error: string }>> {
  const rateLimitedResponse = await enforcePublicApiRateLimit(req);
  if (rateLimitedResponse) return rateLimitedResponse;

  const params = await props.params;
  const { board_name, slug } = params;

  try {
    const layout = await getLayoutBySlug(board_name as BoardName, slug);

    if (!layout) {
      return NextResponse.json(
        { error: `Layout not found for slug: ${slug}` },
        {
          status: 404,
          headers: {
            'Cache-Control': 'public, s-maxage=31536000, immutable', // Even 404s can be cached - layouts don't change
          },
        },
      );
    }

    return NextResponse.json(layout, {
      headers: {
        'Cache-Control': 'public, s-maxage=31536000, immutable', // Cache for 1 year, immutable
      },
    });
  } catch (error) {
    console.error('Route: Error fetching layout by slug:', error);
    return NextResponse.json({ error: 'Failed to fetch layout' }, { status: 500 });
  }
}
