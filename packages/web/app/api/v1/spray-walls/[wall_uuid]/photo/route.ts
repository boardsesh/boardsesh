import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { createRequestLogger } from '@/app/lib/observability/request-logger';
import { fetchSprayWallPhotoUrl } from '@/app/lib/spray/spray-wall-render-data.server';

/**
 * The photograph of an UNLISTED spray wall, behind a redirect that is minted on
 * every request.
 *
 * A public wall does not come through here: it has a stable copy in the
 * world-readable bucket (`SprayWall.publicPhotoUrl`) and its page embeds that
 * directly, which is what lets a CDN and an unfurler cache the image at all.
 *
 * An unlisted wall has no such copy by design — it is read by whoever has the
 * link, through fifteen-minute presigned URLs over the private bucket. Putting
 * one of those straight into the page's HTML looks fine and then breaks: a
 * climb-view URL carries a 24-hour CDN `s-maxage` (`list-page-cache.ts`), so
 * for almost all of that day the cached HTML would point at a signature that
 * expired hours earlier. A stable path in the HTML and a fresh signature per
 * image fetch is the shape that survives the cache.
 *
 * The gate is the backend's, not this route's, and deliberately so. The read is
 * anonymous, so `sprayWallRenderData` applies the wall view rule with no viewer:
 * a public or unlisted wall answers and every private one is "not found". This
 * route therefore cannot leak a private wall even if it wanted to, and it never
 * has to decide anything a resolver already decides.
 */

/** Per-IP cap. Each miss is a backend round trip that mints a signature. */
const MAX_REQUESTS_PER_MINUTE = 60;

/** The template rather than the resolved path, so one wall is not one log route. */
const ROUTE = '/api/v1/spray-walls/[wall_uuid]/photo';

/**
 * Never cached, at any layer. The redirect target is a signature that expires,
 * and a cached 302 would outlive it and pin a dead image on every later reader.
 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(req: Request, props: { params: Promise<{ wall_uuid: string }> }): Promise<Response> {
  const log = createRequestLogger(req, { route: ROUTE });
  const clientIp = getClientIp(req);
  const { limited, retryAfterSeconds } = checkRateLimit(`spray-photo:${clientIp}`, MAX_REQUESTS_PER_MINUTE, 60_000);
  if (limited) {
    return NextResponse.json(
      { error: 'Too many requests. Please slow down.' },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, retryAfterSeconds)) } },
    );
  }

  const { wall_uuid: wallUuid } = await props.params;

  try {
    const photoUrl = await fetchSprayWallPhotoUrl(wallUuid);
    if (!photoUrl) {
      // Same answer for a wall that does not exist, a wall this anonymous read
      // may not see, and a wall whose photo could not be signed. Distinguishing
      // them would make this endpoint an oracle for which uuids are walls.
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
    }

    return NextResponse.redirect(photoUrl, { status: 302, headers: NO_STORE });
  } catch (error) {
    // A failed read is a 502, never a 404: the page linking here is CDN-cached
    // for a day, and a cacheable 404 would outlive the brownout that caused it.
    //
    // `error`, not `info`: this is a server fault, and a dashboard filtering by
    // level would otherwise never see it. One line through the request logger
    // rather than a second `console.error` beside it, so the route, method and
    // Railway request id ride along.
    log.error('spray wall photo read failed', {
      status: 502,
      wallUuid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Upstream read failed' }, { status: 502, headers: NO_STORE });
  }
}
