// Browser-clicked verification link for a domain-verified gym claim.
//
//   GET /api/gym-claims/verify?token=<token>  → 302 to the web app
//
// Token-gated (the token is the credential), so no session is required — the
// same shape as the web app's /api/auth/verify-email. On success the claimant
// becomes the gym owner; either way we redirect to a small web landing page.

import type { IncomingMessage, ServerResponse } from 'http';
import { verifyGymClaimByToken } from '../graphql/resolvers/social/gym-claims';
import { webPublicUrl } from '../email/email-service';
import { logger } from '../utils/logger';

function redirectTo(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

export async function handleGymClaimVerify(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = url.searchParams.get('token') || '';
  const web = webPublicUrl();
  try {
    const result = await verifyGymClaimByToken(token);
    if (result.ok) {
      // Carry the gym so the success page can offer a "set up your gym" deep link.
      // Prefer the slug for a friendly URL; the manage route also resolves by UUID.
      const gymRef = result.gymSlug || result.gymUuid;
      redirectTo(res, `${web}/gym-claim/success?gym=${encodeURIComponent(gymRef)}`);
      return;
    }
    // Name the gym when the token named a claim, so the error page can link
    // back to it ("Back to {gym}"). An unknown token names nothing.
    const gymParam = result.gymRef ? `&gym=${encodeURIComponent(result.gymRef)}` : '';
    redirectTo(res, `${web}/gym-claim/error?reason=${encodeURIComponent(result.reason)}${gymParam}`);
  } catch (error) {
    logger.error('[GymClaim] Verification failed:', error);
    redirectTo(res, `${web}/gym-claim/error?reason=server_error`);
  }
}
