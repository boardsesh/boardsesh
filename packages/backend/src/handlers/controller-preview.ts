import type { IncomingMessage, ServerResponse } from 'node:http';
import { getControllerPreview, normalizeControllerPreviewConfig } from '../services/controller-preview';
import { getPublicClientIp } from '../utils/client-ip';
import { RateLimitError } from '../utils/rate-limiter';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';

/** Public catalog art only: installation names, serials and credentials never enter this route. */
export async function handleControllerPreview(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const fail = (status: number, error: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error }));
  };
  const kind = url.searchParams.get('kind');
  const requestedVersion = url.searchParams.get('v');
  if (
    (kind !== 'image' && kind !== 'geometry') ||
    (requestedVersion !== null && !/^[a-f0-9]{64}$/.test(requestedVersion))
  ) {
    fail(400, 'Invalid controller preview asset');
    return;
  }
  let config;
  try {
    config = normalizeControllerPreviewConfig({
      boardName: url.searchParams.get('board_name') ?? '',
      layoutId: Number(url.searchParams.get('layout_id')),
      sizeId: Number(url.searchParams.get('size_id')),
      setIds: url.searchParams.get('set_ids') ?? '',
    });
  } catch {
    fail(400, 'Invalid controller preview configuration');
    return;
  }
  try {
    await checkRateLimitRedis(getPublicClientIp(req), 'controller-preview', 60, 60_000);
    await checkRateLimitRedis(req.socket.remoteAddress || 'unknown', 'controller-preview-peer', 600, 60_000);
    const preview = await getControllerPreview(config);
    const hash = kind === 'image' ? preview.imageSha256 : preview.geometrySha256;
    if (requestedVersion !== null && requestedVersion !== hash) {
      fail(409, 'Controller preview version changed');
      return;
    }
    const body = kind === 'image' ? preview.image : preview.geometry;
    res.setHeader('ETag', `"${hash}"`);
    res.setHeader('Cache-Control', requestedVersion ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
    if (req.headers['if-none-match'] === `"${hash}"`) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': kind === 'image' ? 'image/jpeg' : 'application/octet-stream',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error instanceof RateLimitError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
      fail(429, 'Rate limit exceeded');
    } else fail(503, 'Controller preview temporarily unavailable');
  }
}
