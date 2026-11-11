import { type NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { soleAccount } from '@boardsesh/auth-protocol/account-email';
import { findAccountsByEmail } from '@boardsesh/db/queries/account-email';
import { sendVerificationEmail } from '@boardsesh/email';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { AuthBackendUnavailableError, webPasswordMode } from '@/app/lib/auth/password-command-client.server';
import { resendVerificationWithCommand } from '@/app/lib/auth/email-verification-command.server';
import { passwordCommandUnavailableResponse } from '@/app/lib/auth/register-password-command.server';
import { stagedPasswordClientKey } from '@/app/lib/auth/trusted-client-ip.server';

// Zod schema for email validation
const resendVerificationSchema = z.object({
  email: z.string().email('Invalid email address'),
});

// A response floor reduces small timing differences. It does not bound SMTP or
// establish equal timing between eligible and ineligible recipients.
const MIN_RESPONSE_TIME_MS = 1500;

// Retain the existing response floor on every branch.
async function consistentDelay(startTime: number): Promise<void> {
  const elapsed = Date.now() - startTime;
  const remaining = MIN_RESPONSE_TIME_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const genericMessage = 'If an account exists and needs verification, a verification email will be sent';

  try {
    // Rate limiting - 5 requests per minute per IP. The staged budget is shared
    // by every caller, so its key must not be forgeable.
    const clientIp = stagedPasswordClientKey(request) ?? getClientIp(request);
    const rateLimitResult = checkRateLimit(`resend-verification:${clientIp}`, 5, 60_000);

    if (rateLimitResult.limited) {
      await consistentDelay(startTime);
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimitResult.retryAfterSeconds),
          },
        },
      );
    }

    if (webPasswordMode() === 'backend-staging') {
      const response = await resendVerificationWithCommand(request);
      await consistentDelay(startTime);
      return response;
    }

    const body = await request.json();

    // Validate input with Zod
    const validationResult = resendVerificationSchema.safeParse(body);
    if (!validationResult.success) {
      await consistentDelay(startTime);
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const db = getDb();

    // Check if user exists and is unverified. Any capitalisation reaches the
    // account, but only one account: an address several accounts share is
    // answered like an unknown one.
    const account = soleAccount(await findAccountsByEmail(db, validationResult.data.email));

    // Don't reveal user status - return same message for all cases
    // Use consistent delay for all paths to prevent timing attacks
    if (!account || account.emailVerified) {
      await consistentDelay(startTime);
      return NextResponse.json({ message: genericMessage }, { status: 200 });
    }

    // The link and its token carry the address as stored, so verify-email
    // finds this same row by exact match.
    const { email } = account;

    // Generate new token
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Delete existing tokens and create new one atomically
    await db.transaction(async (tx) => {
      await tx.delete(schema.verificationTokens).where(eq(schema.verificationTokens.identifier, email));

      await tx.insert(schema.verificationTokens).values({
        identifier: email,
        token,
        expires,
      });
    });

    // `?.trim() ||`, not `??`: Dockerfile.web's runner stage declares
    // `ENV BASE_URL=$BASE_URL`, which is the EMPTY STRING in an image built
    // without the build arg. `??` keeps an empty string and every link in this
    // email would lose its origin; falling back to the request origin is right.
    const baseUrl = process.env.BASE_URL?.trim() || request.nextUrl.origin;
    try {
      await sendVerificationEmail(email, token, baseUrl);
    } catch (emailError) {
      console.error('Failed to resend verification email:', emailError);
      Sentry.captureException(emailError, {
        tags: { area: 'auth', flow: 'resend-verification', phase: 'send-email' },
      });
      await consistentDelay(startTime);
      return NextResponse.json({ error: 'Failed to send verification email' }, { status: 500 });
    }

    await consistentDelay(startTime);
    return NextResponse.json({ message: genericMessage }, { status: 200 });
  } catch (error) {
    if (error instanceof AuthBackendUnavailableError) {
      await consistentDelay(startTime);
      return passwordCommandUnavailableResponse();
    }
    console.error('Resend verification error:', error);
    Sentry.captureException(error, {
      tags: { area: 'auth', flow: 'resend-verification', phase: 'request' },
    });
    await consistentDelay(startTime);
    return NextResponse.json({ error: 'Failed to send verification email' }, { status: 500 });
  }
}
