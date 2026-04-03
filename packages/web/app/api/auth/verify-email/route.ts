import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq, and } from 'drizzle-orm';
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

  const db = getDb();

  // Find the verification token
  const verificationToken = await db
    .select()
    .from(schema.verificationTokens)
    .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)))
    .limit(1);

  if (verificationToken.length === 0) {
    return NextResponse.redirect(new URL('/auth/verify-request?error=InvalidToken', request.url));
  }

  const tokenData = verificationToken[0];

  // Check if token has expired
  if (new Date() > tokenData.expires) {
    // Delete expired token
    await db
      .delete(schema.verificationTokens)
      .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)));

    return NextResponse.redirect(new URL('/auth/verify-request?error=TokenExpired', request.url));
  }

  // Verify user exists before updating
  const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);

  if (user.length === 0) {
    // Token exists but user doesn't - cleanup the orphan token
    await db
      .delete(schema.verificationTokens)
      .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)));

    return NextResponse.redirect(new URL('/auth/verify-request?error=InvalidToken', request.url));
  }

  // Update user and delete token atomically
  await db.transaction(async (tx) => {
    await tx.update(schema.users).set({ emailVerified: new Date() }).where(eq(schema.users.email, email));

    await tx
      .delete(schema.verificationTokens)
      .where(and(eq(schema.verificationTokens.identifier, email), eq(schema.verificationTokens.token, token)));
  });

  // Redirect to the app — the user is likely already logged in
  return NextResponse.redirect(new URL('/?verified=true', request.url));
}
