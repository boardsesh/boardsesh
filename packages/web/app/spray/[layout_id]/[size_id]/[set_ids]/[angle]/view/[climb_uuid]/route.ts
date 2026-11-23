import { parseBoardAngleSegment } from '@boardsesh/board-config';
import { z } from 'zod';
import { getGraphQLHttpUrl } from '@/app/lib/backend-url';
import { isNumericId } from '@/app/lib/board-route-paths';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { readWallCapability, resolveSprayWallAccess } from '@/app/lib/spray/spray-visibility';

type LegacySprayClimbParams = {
  layout_id: string;
  size_id: string;
  set_ids: string;
  angle: string;
  climb_uuid: string;
};

type SprayWallTarget = {
  uuid: string;
  board: { slug: string; isPublic: boolean; isUnlisted: boolean };
};

const WALL_TARGET_QUERY = `
  query LegacySprayClimbTarget($layoutId: Int!, $sprayWallUuid: String) {
    sprayWallByLayout(layoutId: $layoutId, sprayWallUuid: $sprayWallUuid) {
      uuid
      board { slug isPublic isUnlisted }
    }
  }
`;
const wallUuidSchema = z.string().uuid();

// A compatibility URL, never an indexed page or a cached visibility decision.
const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, follow',
};

/**
 * Beta cards and older shares can address a spray climb by its numeric tuple.
 * This static route bypasses the catalogue layout, which deliberately refuses
 * spray walls, and hands the climb to the existing /b/{slug} page instead.
 */
export async function GET(request: Request, props: { params: Promise<LegacySprayClimbParams> }): Promise<Response> {
  const params = await props.params;
  const layoutId = Number(params.layout_id);
  const angle = parseBoardAngleSegment('spray', params.angle);
  if (
    !isNumericId(params.layout_id) ||
    !Number.isInteger(layoutId) ||
    layoutId <= 0 ||
    layoutId > 2147483647 ||
    !isNumericId(params.size_id) ||
    Number(params.size_id) !== layoutId ||
    params.set_ids !== '1' ||
    angle === null
  ) {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  const requestedUrl = new URL(request.url);
  const wallParams = requestedUrl.searchParams.getAll('wall');
  const wallParam = wallParams.length > 1 ? wallParams : wallParams[0];
  const wallUuid = readWallCapability(wallParam);
  if (wallParam !== undefined && !wallUuidSchema.safeParse(wallUuid).success) {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  let wall: SprayWallTarget | null;
  try {
    // Anonymous and uncached: sequential layout IDs grant no access to an
    // unlisted wall, even when the caller happens to be its signed-in owner.
    const response = await fetch(getGraphQLHttpUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...webClientIdentityHeaders() },
      body: JSON.stringify({ query: WALL_TARGET_QUERY, variables: { layoutId, sprayWallUuid: wallUuid } }),
      cache: 'no-store',
      signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return new Response(null, { status: 503, headers: responseHeaders });
    const payload = (await response.json()) as {
      data?: { sprayWallByLayout: SprayWallTarget | null };
      errors?: unknown[];
    };
    if (payload.errors?.length || !payload.data || !('sprayWallByLayout' in payload.data)) {
      return new Response(null, { status: 503, headers: responseHeaders });
    }
    wall = payload.data.sprayWallByLayout;
  } catch {
    // Backend failures must remain retryable, never a cached "climb missing".
    // Do not log the request: an unlisted wall UUID is a share-link capability.
    return new Response(null, { status: 503, headers: responseHeaders });
  }

  if (!wall?.board.slug || resolveSprayWallAccess({ ...wall.board, uuid: wall.uuid }, wallParam) !== 'render') {
    return new Response(null, { status: 404, headers: responseHeaders });
  }

  const targetPath = `/b/${encodeURIComponent(wall.board.slug)}/${angle}/view/${encodeURIComponent(params.climb_uuid)}`;
  const targetUrl = new URL(localeHref(targetPath, await getLocale()), requestedUrl);
  targetUrl.search = requestedUrl.search;
  // A wall's slug and visibility can change. Recheck them on every visit.
  return new Response(null, { status: 307, headers: { ...responseHeaders, Location: targetUrl.href } });
}
