import type { IncomingMessage } from 'node:http';

/**
 * Stable client identity behind Cloudflare and Railway.
 *
 * Cloudflare's authenticated edge header wins. Otherwise Railway appends the
 * peer it observed to x-forwarded-for, so the last hop is the non-spoofable one.
 * Callers should pair this with a socket-peer ceiling because a direct client
 * can supply cf-connecting-ip before the request reaches Railway.
 */
export function getPublicClientIp(req: IncomingMessage): string {
  const cloudflareClientIp = req.headers['cf-connecting-ip'];
  const cloudflareIp = Array.isArray(cloudflareClientIp) ? cloudflareClientIp[0] : cloudflareClientIp;
  if (cloudflareIp?.trim()) return cloudflareIp.trim();

  const forwarded = req.headers['x-forwarded-for'];
  const forwardedChain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const lastHop = forwardedChain?.split(',').at(-1)?.trim();
  return lastHop || req.socket.remoteAddress || 'unknown';
}
