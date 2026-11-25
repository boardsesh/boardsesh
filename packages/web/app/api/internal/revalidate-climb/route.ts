import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

export const dynamic = 'force-dynamic';

const REVALIDATE_SECRET = process.env.REVALIDATE_SECRET;

/**
 * Backend mutations call this route after a climb's row or its community
 * status row changes. We revalidate the `climb-${uuid}` tag so the next
 * /[board]/.../view/[climb_uuid] render rebuilds with fresh data instead of
 * waiting for the 1h `unstable_cache` TTL to expire.
 *
 * This only reaches Next's data cache. Climb-view HTML and Flight responses
 * now carry private/no-store headers; external copies stored under the older
 * CDN policy must be invalidated when that policy change rolls out.
 *
 * Auth: bearer token equal to REVALIDATE_SECRET — kept distinct from
 * CRON_SECRET so a leaked backend env doesn't grant access to other
 * cron-triggered routes that might do more than cache busting.
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!REVALIDATE_SECRET || authHeader !== `Bearer ${REVALIDATE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { climbUuid?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { climbUuid } = body;
  if (typeof climbUuid !== 'string' || climbUuid.length === 0) {
    return NextResponse.json({ error: 'climbUuid is required' }, { status: 400 });
  }

  revalidateTag(`climb-${climbUuid}`, { expire: 0 });

  return new NextResponse(null, { status: 204 });
}
