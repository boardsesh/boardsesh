import { NextResponse } from 'next/server';
import { type SetRow, getSetsBySlug } from '@/app/lib/slug-utils';
import { enforcePublicApiRateLimit } from '@/app/lib/public-api-rate-limit.server';
import type { BoardName } from '@/app/lib/types';

export async function GET(
  req: Request,
  props: {
    params: Promise<{ board_name: string; layout_id: string; size_id: string; slug: string }>;
  },
): Promise<NextResponse<SetRow[] | { error: string }>> {
  const rateLimitedResponse = await enforcePublicApiRateLimit(req);
  if (rateLimitedResponse) return rateLimitedResponse;

  const params = await props.params;
  const { board_name, layout_id, size_id, slug } = params;

  try {
    const sets = await getSetsBySlug(board_name as BoardName, Number(layout_id), Number(size_id), slug);

    if (sets.length === 0) {
      return NextResponse.json(
        { error: `Sets not found for slug: ${slug}` },
        {
          status: 404,
          headers: {
            'Cache-Control': 'public, s-maxage=31536000, immutable', // Even 404s can be cached - sets don't change
          },
        },
      );
    }

    return NextResponse.json(sets, {
      headers: {
        'Cache-Control': 'public, s-maxage=31536000, immutable', // Cache for 1 year, immutable
      },
    });
  } catch (error) {
    console.error('Error fetching sets by slug:', error);
    return NextResponse.json({ error: 'Failed to fetch sets' }, { status: 500 });
  }
}
