import { type NextRequest } from 'next/server';
import { checkRateLimit } from '@/app/lib/auth/rate-limiter';
import {
  emailVerificationTokenSchema,
  isReservedAuthRecordIdentifier,
  isVersionedEmailVerificationToken,
} from '@boardsesh/auth-protocol';
import { webPasswordMode } from '@/app/lib/auth/password-command-client.server';
import {
  emailVerificationRedirect,
  emailVerificationUnavailableResponse,
} from '@/app/lib/auth/email-verification-response.server';
import { verifyEmailWithCommand } from '@/app/lib/auth/email-verification-command.server';
import { trustedClientRateLimitKey } from '@/app/lib/auth/trusted-client-ip.server';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const email = request.nextUrl.searchParams.get('email');
  const versioned = typeof token === 'string' && isVersionedEmailVerificationToken(token);
  try {
    webPasswordMode();
  } catch {
    return emailVerificationUnavailableResponse(request);
  }
  // Recognize the whole reserved namespace before disabled/legacy dispatch.
  // An older reader must not delete or verify a newer reader's receipt.
  if (versioned && !token.startsWith('ev1_')) {
    return emailVerificationUnavailableResponse(request);
  }
  if (!versioned && isReservedAuthRecordIdentifier(email)) {
    return emailVerificationRedirect(request, '/auth/verify-request?error=InvalidToken');
  }
  // Rate limiting - 20 attempts per minute per IP
  // Higher limit than other endpoints since users may click verification link multiple times
  // Apply the trusted last-hop key independently of the auth mode.
  const clientIp = trustedClientRateLimitKey(request);
  const rateLimitResult = checkRateLimit(`verify-email:${clientIp}`, 20, 60_000);

  if (rateLimitResult.limited) {
    return emailVerificationRedirect(request, '/auth/verify-request?error=TooManyAttempts');
  }

  if (versioned) {
    if (!emailVerificationTokenSchema.safeParse(token).success)
      return emailVerificationRedirect(request, '/auth/verify-request?error=InvalidToken');
    // The token owns its immutable subject binding. Query email is ignored.
    return verifyEmailWithCommand(request, token);
  }

  if (!token || !email) {
    return emailVerificationRedirect(request, '/auth/verify-request?error=InvalidToken');
  }

  // Unknown historical formats are uncertainty; never delete a live row just
  // because the private transport cannot represent it.
  if (token.length > 256) return emailVerificationUnavailableResponse(request);
  return verifyEmailWithCommand(request, token, email);
}
