import type { IncomingMessage } from 'node:http';
import { normalizeIpAddress } from '@boardsesh/consent/edge-country';
import { CLOUDFLARE_ORIGIN_PROOF_HEADER } from '@boardsesh/consent/origin-proof';
import { verifyOriginProof } from '@boardsesh/consent/origin-proof-server';
import { isPublicAddress } from './flag-country';

/**
 * Authenticate our zone's analytics transform independently of proxy hop count.
 * Production has a CGNAT socket and a public Railway hop after Cloudflare in
 * XFF; neither a fixed hop count nor an earlier Cloudflare address proves origin.
 * Keep this separate from the generic edge resolver used by auth and consent.
 */
export function resolvePosthogVisitorIp(req: IncomingMessage, url: URL): string | null {
  if (req.headers.host !== 'ws.boardsesh.com' || !url.pathname.startsWith('/api/posthog/')) return null;
  const proof = req.headers[CLOUDFLARE_ORIGIN_PROOF_HEADER.toLowerCase()];
  if (
    verifyOriginProof(typeof proof === 'string' ? proof : undefined, [
      process.env.POSTHOG_ORIGIN_PROOF_SECRET,
      process.env.POSTHOG_ORIGIN_PROOF_SECRET_NEXT,
    ]) !== 'proven'
  )
    return null;
  const connecting = req.headers['cf-connecting-ip'];
  const address = normalizeIpAddress(typeof connecting === 'string' ? connecting : undefined);
  return address && isPublicAddress(address) ? address : null;
}
