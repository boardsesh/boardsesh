import { mintDeviceToken, readDeviceTokenSecret } from '@boardsesh/auth-protocol/device-token';
import { createWebGuessLimitClient } from '@/app/lib/auth/guess-limit-client.server';
import { appendDeviceTokenCookie } from '@/app/lib/auth/device-token-request.server';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { getPasswordResetIdentifier, hashResetToken, consistentDelay } from '@/app/lib/auth/password-reset';
import { isVersionedPasswordRecoveryToken, passwordRecoveryTokenSchema } from '@boardsesh/auth-protocol';
import { findAccountsByEmail } from '@boardsesh/db/queries/account-email';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import { AuthBackendUnavailableError, webPasswordMode } from '@/app/lib/auth/password-command-client.server';
import {
  INVALID_PASSWORD_RESET_MESSAGE,
  passwordRecoveryUnavailableResponse,
  resetPasswordWithCommand,
} from '@/app/lib/auth/password-recovery-command.server';
import { withEmailVerificationPrivacy } from '@/app/lib/auth/email-verification-response.server';
import { stagedPasswordClientKey } from '@/app/lib/auth/trusted-client-ip.server';
import { LEGACY_PASSWORD_RESET_LIFETIME_MS, legacyLinkAccount } from '@/app/lib/auth/legacy-link-account';

const resetPasswordSchema = z
  .object({
    email: z.string().email('Invalid email address'),
    token: z.string().uuid('Invalid reset token'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must be less than 128 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const MIN_RESPONSE_TIME_MS = 1500;

export async function POST(request: NextRequest) {
  return withEmailVerificationPrivacy(await handleResetPassword(request));
}

async function handleResetPassword(request: NextRequest) {
  const startTime = Date.now();
  let staged = false;
  try {
    // The staged budget is shared by every caller, so its key must not be forgeable.
    const clientIp = stagedPasswordClientKey(request) ?? getClientIp(request);
    // NOTE: checkRateLimit is in-memory and not shared across serverless instances.
    // This provides best-effort protection only. Add Redis/Upstash rate limiting
    // before relying on this as a production security control.
    const rateLimitResult = checkRateLimit(`reset-password:${clientIp}`, 5, 60_000);

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

    const mode = webPasswordMode();
    staged = mode === 'backend-staging';
    const body: unknown = await request.json();
    const submittedToken: unknown =
      typeof body === 'object' && body !== null && 'token' in body ? body.token : undefined;
    if (isVersionedPasswordRecoveryToken(submittedToken)) {
      if (!staged || typeof submittedToken !== 'string' || !/^pr1_/i.test(submittedToken)) {
        await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
        return passwordRecoveryUnavailableResponse();
      }
      if (!passwordRecoveryTokenSchema.safeParse(submittedToken).success) {
        await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
        return withEmailVerificationPrivacy(
          NextResponse.json({ error: INVALID_PASSWORD_RESET_MESSAGE }, { status: 400 }),
        );
      }
    }
    if (staged) {
      const response = await resetPasswordWithCommand(body);
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return response;
    }
    const validationResult = resetPasswordSchema.safeParse(body);

    if (!validationResult.success) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const { email, token, password } = validationResult.data;
    const db = getDb();
    const identifier = getPasswordResetIdentifier(email);
    const tokenHash = hashResetToken(token);

    const now = new Date();
    const resetToken = await db
      .select({ expires: schema.verificationTokens.expires })
      .from(schema.verificationTokens)
      .where(
        and(
          eq(schema.verificationTokens.identifier, identifier),
          eq(schema.verificationTokens.token, tokenHash),
          gt(schema.verificationTokens.expires, now),
        ),
      )
      .limit(1);

    if (resetToken.length === 0) {
      // Do NOT delete here — a wrong token in this position could let an attacker
      // invalidate a victim's freshly-issued token (DoS). Tokens expire naturally
      // (1 hour TTL) and are cleaned up by the delete-before-insert in forgot-password.
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 400 });
    }

    // The token row only carries the email-derived identifier, not the user id.
    // Bind it to the one account it was issued for: the only row storing this
    // exact address, created before the link. Never another capitalisation, so a
    // link for an account since deleted cannot reset its case sibling.
    const account = legacyLinkAccount(await findAccountsByEmail(db, email), {
      expires: resetToken[0].expires,
      lifetimeMs: LEGACY_PASSWORD_RESET_LIFETIME_MS,
    });
    if (!account) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_COST);

    await db.transaction(async (tx) => {
      const existingCredentials = await tx
        .select({ userId: schema.userCredentials.userId })
        .from(schema.userCredentials)
        .where(eq(schema.userCredentials.userId, account.id))
        .limit(1);

      if (existingCredentials.length > 0) {
        await tx
          .update(schema.userCredentials)
          .set({ passwordHash, updatedAt: new Date() })
          .where(eq(schema.userCredentials.userId, account.id));
      } else {
        // Insert credentials for OAuth-only users who want to add a password.
        // In practice forgot-password skips OAuth-only accounts, but this supports
        // future flows where an admin or other path may issue a reset token directly.
        await tx.insert(schema.userCredentials).values({
          userId: account.id,
          passwordHash,
        });
      }

      // Completing a reset proves the user controls the inbox the link was sent to,
      // so mark previously-unverified emails as verified here. Scoped to NULL
      // emailVerified rows so we never overwrite an existing verification timestamp.
      await tx
        .update(schema.users)
        .set({ emailVerified: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.users.id, account.id), isNull(schema.users.emailVerified)));

      await tx.delete(schema.verificationTokens).where(eq(schema.verificationTokens.identifier, identifier));
    });

    await createWebGuessLimitClient()?.clear(account.email);
    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    const response = NextResponse.json({
      message: 'Password reset successful. You can now sign in with your new password.',
    });
    const secret = readDeviceTokenSecret(process.env);
    if ('secret' in secret) {
      try {
        const deviceToken = await mintDeviceToken({ userId: account.id, secret: secret.secret });
        appendDeviceTokenCookie(response, deviceToken.token);
      } catch {
        // A completed reset remains successful if device recognition cannot be minted.
      }
    }
    return response;
  } catch (error) {
    if (staged || error instanceof AuthBackendUnavailableError) {
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return passwordRecoveryUnavailableResponse();
    }
    console.error('Password reset request failed');
    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
