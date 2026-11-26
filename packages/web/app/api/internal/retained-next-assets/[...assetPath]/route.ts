import { isRetainedNextAssetsEnabled } from '@/config/retained-next-assets.mjs';
import { getRetainedNextAssetUrl } from '@/app/lib/retained-next-assets';

type RouteContext = { params: Promise<{ assetPath: string[] }> };

const RETAINED_ASSET_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, follow',
} as const;

// afterFiles reaches this handler only when Next cannot serve the local file.
// Redirect instead of proxying so request headers/bodies never leave the server.
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  if (!isRetainedNextAssetsEnabled())
    return new Response(null, { status: 404, headers: RETAINED_ASSET_RESPONSE_HEADERS });
  const contentLength = request.headers.get('content-length');
  if (request.headers.has('transfer-encoding') || (contentLength !== null && !/^0+$/u.test(contentLength))) {
    return new Response(null, { status: 400, headers: RETAINED_ASSET_RESPONSE_HEADERS });
  }
  const { assetPath } = await context.params;
  const assetUrl = getRetainedNextAssetUrl(assetPath);
  if (!assetUrl) return new Response(null, { status: 404, headers: RETAINED_ASSET_RESPONSE_HEADERS });
  // The original query can carry private navigation context; never copy it.
  return new Response(null, { status: 307, headers: { ...RETAINED_ASSET_RESPONSE_HEADERS, Location: assetUrl.href } });
}

export const HEAD = GET;

function rejectMethod(): Response {
  if (!isRetainedNextAssetsEnabled())
    return new Response(null, { status: 404, headers: RETAINED_ASSET_RESPONSE_HEADERS });
  return new Response(null, { status: 405, headers: { ...RETAINED_ASSET_RESPONSE_HEADERS, Allow: 'GET, HEAD' } });
}

export {
  rejectMethod as POST,
  rejectMethod as PUT,
  rejectMethod as PATCH,
  rejectMethod as DELETE,
  rejectMethod as OPTIONS,
};
