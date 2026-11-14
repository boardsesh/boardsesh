import 'server-only';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';

export class PublicAuthRequestError extends Error {
  constructor(readonly status: 400 | 403 | 503) {
    super('Public auth request refused');
  }
}
/** Configuration and the exact Host/Origin, never forwarded headers, select
 * the origin used for account-bound mail and mutation requests. */
export function requirePublicAuthRequest(
  request: Request,
  path: string,
  method: 'GET' | 'POST',
  environment: AuthServiceEnvironment,
): string {
  const origin = resolvePublicAuthOrigin(environment);
  if (!origin || new URL(origin).protocol !== 'https:') throw new PublicAuthRequestError(503);
  const url = new URL(request.url);
  if (request.headers.get('host') !== new URL(origin).host) throw new PublicAuthRequestError(403);
  if (url.pathname !== path || url.search !== '' || request.method !== method) throw new PublicAuthRequestError(400);
  const claimedOrigin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (
    (claimedOrigin !== null && claimedOrigin !== origin) ||
    (method === 'POST' && claimedOrigin !== origin) ||
    (fetchSite !== null && fetchSite !== 'same-origin' && !(method === 'GET' && fetchSite === 'none'))
  )
    throw new PublicAuthRequestError(403);
  return origin;
}
export function boundedAuthCookiePairs(header: string | null): readonly { name: string; content: string }[] {
  if (!header) return [];
  if (Buffer.byteLength(header) > 32_768) throw new PublicAuthRequestError(400);
  for (let index = 0; index < header.length; index++) {
    const code = header.charCodeAt(index);
    if ((code < 32 && code !== 9) || code === 127) throw new PublicAuthRequestError(400);
  }
  const pairs = header.split(';');
  if (pairs.length > 128) throw new PublicAuthRequestError(400);
  return pairs
    .filter((pair) => pair.trim())
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator <= 0) throw new PublicAuthRequestError(400);
      return { name: pair.slice(0, separator).trim(), content: pair.slice(separator + 1).trim() };
    });
}
/** Bound actual bytes, UTF-8 and time even when Content-Length is absent. */
export async function readBoundedAuthJson(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
    request.headers.has('content-encoding')
  )
    throw new PublicAuthRequestError(400);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 65_536))
    throw new PublicAuthRequestError(400);
  if (!request.body || request.signal.aborted) throw new PublicAuthRequestError(400);
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      reject(new PublicAuthRequestError(400));
      void reader.cancel().catch(() => {});
    };
    timer = setTimeout(cancel, 5_000);
  });
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let length = 0;
    let text = '';
    while (true) {
      if (request.signal.aborted) throw new PublicAuthRequestError(400);
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65_536) throw new PublicAuthRequestError(400);
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (request.signal.aborted || (declared !== null && Number(declared) !== length))
      throw new PublicAuthRequestError(400);
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => {});
    throw new PublicAuthRequestError(400);
  } finally {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
