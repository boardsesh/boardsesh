import { type NextRequest } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import {
  emailVerificationTokenSchema,
  isReservedAuthRecordIdentifier,
  isVersionedEmailVerificationToken,
} from '@boardsesh/auth-protocol';
import { soleAccount } from '@boardsesh/auth-protocol/account-email';
import { findAccountsByEmail } from '@boardsesh/db/queries/account-email';
import { webPasswordMode } from '@/app/lib/auth/password-command-client.server';
import {
  emailVerificationRedirect,
  emailVerificationUnavailableResponse,
} from '@/app/lib/auth/email-verification-response.server';
import { verifyEmailWithCommand } from '@/app/lib/auth/email-verification-command.server';
import { stagedPasswordClientKey } from '@/app/lib/auth/trusted-client-ip.server';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const email = request.nextUrl.searchParams.get('email');
  const versioned = typeof token === 'string' && isVersionedEmailVerificationToken(token);
  let mode: ReturnType<typeof webPasswordMode>;
  try {
    mode = webPasswordMode();
  } catch {
    return emailVerificationUnavailableResponse(request);
  }
  // Recognize the whole reserved namespace before disabled/legacy dispatch.
  // An older reader must not delete or verify a newer reader's receipt.
  if (versioned && (mode !== 'backend-staging' || !token.startsWith('ev1_'))) {
    return emailVerificationUnavailableResponse(request);
  }
  if (!versioned && isReservedAuthRecordIdentifier(email)) {
    return emailVerificationRedirect(request, '/auth/verify-request?error=InvalidToken');
  }
  // Rate limiting - 20 attempts per minute per IP
  // Higher limit than other endpoints since users may click verification link multiple times
  // The staged budget is shared by every caller, so its key must not be forgeable.
  const clientIp = stagedPasswordClientKey(request) ?? getClientIp(request);
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

  if (mode === 'backend-staging') {
    // Historical storage had no token length bound. Unsupported syntax is
    // uncertainty, not proof that an otherwise live historical link is invalid.
    if (token.length > 256) return emailVerificationUnavailableResponse(request);
    return verifyEmailWithCommand(request, token, email);
  }

  const db = getDb();

  // Find the verification token
  const verificationToken = await db
    .select()
    .from(schema.verificationTokens)
    .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)))
    .limit(1);

  if (verificationToken.length === 0) {
    return emailVerificationRedirect(request, '/auth/verify-request?error=InvalidToken');
  }

  const tokenData = verificationToken[0];

  // Check if token has expired
  if (new Date() > tokenData.expires) {
    // Delete expired token
    await db
      .delete(schema.verificationTokens)
      .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)));

    return emailVerificationRedirect(request, '/auth/verify-request?error=TokenExpired');
  }

  // Verify user exists before updating. The link's address is matched exactly
  // first, then in other capitals only when one account has it.
  const found = await findAccountsByEmail(db, email);
  const account = soleAccount(found);

  if (!account) {
    // Token exists but user doesn't - cleanup the orphan token. An address
    // several accounts share is not an orphan: refuse and let the link expire.
    if (found.kind === 'none') {
      await db
        .delete(schema.verificationTokens)
        .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)));
    }

    return emailVerificationRedirect(request, '/auth/verify-request?error=InvalidToken');
  }

  // Update user and delete token atomically. Only the one account this link
  // names, never every row that stores the same text.
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ emailVerified: new Date() }).where(eq(schema.users.id, account.id));

    await tx
      .delete(schema.verificationTokens)
      .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)));
  });

  // Redirect to login with success message
  return emailVerificationRedirect(request, '/auth/login?verified=true');
}
