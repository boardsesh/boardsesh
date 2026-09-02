/**
 * Dev-only proxy for Instagram + TikTok beta-link thumbnails.
 *
 * The `betaLinks` GraphQL resolver caches thumbnails to object storage in
 * production. In local development there is no bucket, so the resolver returns
 * URLs that point at this route — letting the browser fetch CDN thumbnails
 * through our backend instead of cross-origin against fbcdn / cdninstagram /
 * tiktokcdn.
 *
 * FAIL-CLOSED: this is an SSRF surface, so it is off unless
 * `BETA_LINK_THUMBNAIL_DEV_PROXY=enabled` is set — which only ever happens in a
 * local `.env.local`. It used to key off `AWS_S3_BUCKET_NAME` instead, which
 * made a storage variable load-bearing for a security control: deleting that
 * variable during a bucket migration would have silently re-opened the proxy in
 * production.
 */
import { type NextRequest, NextResponse } from 'next/server';

const ALLOWED_HOST_SUFFIXES = [
  '.fbcdn.net',
  '.cdninstagram.com',
  '.tiktokcdn.com',
  '.tiktokcdn-us.com',
  '.tiktokcdn-eu.com',
];
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export const dynamic = 'force-dynamic';

function isProxyDisabled(): boolean {
  return process.env.BETA_LINK_THUMBNAIL_DEV_PROXY !== 'enabled';
}

export async function GET(request: NextRequest) {
  if (isProxyDisabled()) {
    return new NextResponse('Disabled', { status: 410 });
  }
  const target = request.nextUrl.searchParams.get('url');
  if (!target) return new NextResponse('Missing url', { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new NextResponse('Invalid url', { status: 400 });
  }
  if (parsed.protocol !== 'https:') return new NextResponse('Invalid protocol', { status: 400 });
  const hostAllowed = ALLOWED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
  if (!hostAllowed) return new NextResponse('Host not allowed', { status: 400 });

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Block redirects: a CDN URL that 30x's into an internal address would
      // otherwise be silently followed. Allowlist applies only to the URL we
      // were handed, not whatever the upstream wants to bounce us to.
      redirect: 'error',
      cache: 'no-store',
    });
    if (!upstream.ok || !upstream.body) {
      return new NextResponse('Upstream failed', { status: upstream.status || 502 });
    }
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      },
    });
  } catch {
    return new NextResponse('Fetch failed', { status: 502 });
  }
}
