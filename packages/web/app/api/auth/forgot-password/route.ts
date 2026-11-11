import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { soleAccount } from '@boardsesh/auth-protocol/account-email';
import { findAccountsByEmail } from '@boardsesh/db/queries/account-email';
import { sendPasswordResetEmail } from '@boardsesh/email';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { getPasswordResetIdentifier, hashResetToken, consistentDelay } from '@/app/lib/auth/password-reset';
import { AuthBackendUnavailableError, webPasswordMode } from '@/app/lib/auth/password-command-client.server';
import {
  forgotPasswordWithCommand,
  passwordRecoveryUnavailableResponse,
} from '@/app/lib/auth/password-recovery-command.server';
import { withEmailVerificationPrivacy } from '@/app/lib/auth/email-verification-response.server';
import { stagedPasswordClientKey } from '@/app/lib/auth/trusted-client-ip.server';

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const MIN_RESPONSE_TIME_MS = 1500;

export async function POST(request: NextRequest) {
  return withEmailVerificationPrivacy(await handleForgotPassword(request));
}

async function handleForgotPassword(request: NextRequest) {
  const startTime = Date.now();
  const genericMessage = 'If an account exists for this email, a reset link will be sent.';
  let staged = false;

  try {
    // The staged budget is shared by every caller, so its key must not be forgeable.
    const clientIp = stagedPasswordClientKey(request) ?? getClientIp(request);
    // NOTE: checkRateLimit is in-memory and not shared across serverless instances.
    // This provides best-effort protection only. Add Redis/Upstash rate limiting
    // before relying on this as a production security control.
    const rateLimitResult = checkRateLimit(`forgot-password:${clientIp}`, 5, 60_000);

    if (rateLimitResult.limited) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
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

    staged = webPasswordMode() === 'backend-staging';
    const body: unknown = await request.json();
    if (staged) {
      const response = await forgotPasswordWithCommand(request, body);
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return response;
    }
    const validationResult = forgotPasswordSchema.safeParse(body);

    if (!validationResult.success) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const db = getDb();

    // Any capitalisation reaches the account, but only one account: an address
    // several accounts share is answered like an unknown one.
    const account = soleAccount(await findAccountsByEmail(db, validationResult.data.email));

    // OAuth-only accounts have no password to reset.
    if (!account || account.passwordHash === null) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json({ message: genericMessage }, { status: 200 });
    }

    // The link and its token carry the address as stored, so reset-password
    // finds this same row by exact match.
    const { email } = account;
    const token = crypto.randomUUID();
    const tokenHash = hashResetToken(token);
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    const identifier = getPasswordResetIdentifier(email);

    await db.transaction(async (tx) => {
      await tx.delete(schema.verificationTokens).where(eq(schema.verificationTokens.identifier, identifier));

      // Store the hash, not the raw token — raw token is only in the email link.
      await tx.insert(schema.verificationTokens).values({
        identifier,
        token: tokenHash,
        expires,
      });
    });

    // `?.trim() ||`, not `??`: Dockerfile.web's runner stage declares
    // `ENV BASE_URL=$BASE_URL`, which is the EMPTY STRING in an image built
    // without the build arg. `??` keeps an empty string and every link in this
    // email would lose its origin; falling back to the request origin is right.
    const baseUrl = process.env.BASE_URL?.trim() || request.nextUrl.origin;
    // Email is sent outside the transaction intentionally (nodemailer is not transactional).
    // If this throws, the token remains in the DB but unreachable to the user — the
    // delete-before-insert at the start of the next attempt cleans it up automatically.
    // Return the generic message even on SMTP failure to avoid user enumeration
    // ("account exists but email failed" vs "no account").
    try {
      await sendPasswordResetEmail(email, token, baseUrl);
    } catch {
      // Swallow so the response stays generic (no user enumeration), but surface
      // the failure to Sentry — a misconfigured SMTP credential would otherwise
      // fail silently for every user with no signal in observability tooling.
      console.error('Password recovery email delivery failed');
      Sentry.captureException(new Error('Password recovery email delivery failed'), {
        tags: { area: 'auth', flow: 'forgot-password', phase: 'send-email' },
      });
    }

    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    return NextResponse.json({ message: genericMessage }, { status: 200 });
  } catch (error) {
    if (staged || error instanceof AuthBackendUnavailableError) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return passwordRecoveryUnavailableResponse();
    }
    console.error('Forgot password request failed');
    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    return NextResponse.json({ error: 'Failed to process password reset request' }, { status: 500 });
  }
}
