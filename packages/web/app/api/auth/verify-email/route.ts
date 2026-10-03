import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { normalizeEmail } from '@boardsesh/db/utils';
import { getEmailVerificationTokenUserId } from '@/app/lib/auth/email-verification-token';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';

export async function GET(request: NextRequest) {
  // Rate limiting - 20 attempts per minute per IP
  // Higher limit than other endpoints since users may click verification link multiple times
  const clientIp = getClientIp(request);
  const rateLimitResult = checkRateLimit(`verify-email:${clientIp}`, 20, 60_000);

  if (rateLimitResult.limited) {
    return NextResponse.redirect(new URL('/auth/verify-request?error=TooManyAttempts', request.url));
  }

  const searchParams = request.nextUrl.searchParams;
  const token = searchParams.get('token');
  const email = searchParams.get('email');

  if (!token || !email) {
    return NextResponse.redirect(new URL('/auth/verify-request?error=InvalidToken', request.url));
  }

  // The token row is authoritative for identity. Current tokens carry the
  // selected user id; legacy email-only tokens are accepted only when that
  // email resolves to exactly one account.
  const normalizedEmail = normalizeEmail(email);

  const db = getDb();

  // Raw verification tokens are random UUIDs. Read at most two rows so an
  // unexpected duplicate token fails closed instead of choosing an account.
  const verificationToken = await db
    .select()
    .from(schema.verificationTokens)
    .where(eq(schema.verificationTokens.token, token))
    .limit(2);

  if (verificationToken.length !== 1) {
    return NextResponse.redirect(new URL('/auth/verify-request?error=InvalidToken', request.url));
  }

  const tokenData = verificationToken[0];

  // Check if token has expired
  if (new Date() > tokenData.expires) {
    // Delete expired token
    await db
      .delete(schema.verificationTokens)
      .where(
        and(eq(schema.verificationTokens.identifier, tokenData.identifier), eq(schema.verificationTokens.token, token)),
      );

    return NextResponse.redirect(new URL('/auth/verify-request?error=TokenExpired', request.url));
  }

  const tokenUserId = getEmailVerificationTokenUserId(tokenData.identifier);
  let user: Array<{ id: string }>;
  if (tokenUserId) {
    // Bind current tokens to both the issuing account and its email address.
    // This prevents a stale link from verifying a changed address.
    user = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, tokenUserId), sql`lower(${schema.users.email}) = ${normalizedEmail}`))
      .limit(1);
  } else {
    // Old rows stored only the raw email as identifier. Their original account
    // cannot be recovered if case-insensitive duplicates still exist, so reject
    // that legacy link until the account merge leaves one match.
    if (normalizeEmail(tokenData.identifier) !== normalizedEmail) {
      return NextResponse.redirect(new URL('/auth/verify-request?error=InvalidToken', request.url));
    }
    user = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${normalizedEmail}`)
      .limit(2);
    if (user.length !== 1) {
      return NextResponse.redirect(new URL('/auth/verify-request?error=InvalidToken', request.url));
    }
  }

  if (user.length === 0) {
    // Token exists but user doesn't - cleanup the orphan token
    await db
      .delete(schema.verificationTokens)
      .where(
        and(eq(schema.verificationTokens.identifier, tokenData.identifier), eq(schema.verificationTokens.token, token)),
      );

    return NextResponse.redirect(new URL('/auth/verify-request?error=InvalidToken', request.url));
  }

  // Update user and delete token atomically
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ emailVerified: new Date() }).where(eq(schema.users.id, user[0].id));

    await tx
      .delete(schema.verificationTokens)
      .where(
        and(eq(schema.verificationTokens.identifier, tokenData.identifier), eq(schema.verificationTokens.token, token)),
      );
  });

  // Redirect to login with success message
  return NextResponse.redirect(new URL('/auth/login?verified=true', request.url));
}
