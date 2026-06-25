import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { getPasswordResetIdentifier, hashResetToken, consistentDelay } from '@/app/lib/auth/password-reset';

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
  const startTime = Date.now();
  try {
    const clientIp = getClientIp(request);
    // NOTE: checkRateLimit is in-memory and not shared across serverless instances.
    // This provides best-effort protection only. Add Redis/Upstash rate limiting
    // before relying on this as a production security control.
    const rateLimitResult = checkRateLimit(`reset-password:${clientIp}`, 10, 60_000);

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

    const body = await request.json();
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
      .select()
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
      await db.delete(schema.verificationTokens).where(eq(schema.verificationTokens.identifier, identifier));
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 400 });
    }

    const user = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (user.length === 0) {
      await db.delete(schema.verificationTokens).where(eq(schema.verificationTokens.identifier, identifier));
      await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
      return NextResponse.json({ error: 'Invalid or expired reset link' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await db.transaction(async (tx) => {
      const existingCredentials = await tx
        .select({ userId: schema.userCredentials.userId })
        .from(schema.userCredentials)
        .where(eq(schema.userCredentials.userId, user[0].id))
        .limit(1);

      if (existingCredentials.length > 0) {
        await tx
          .update(schema.userCredentials)
          .set({ passwordHash, updatedAt: new Date() })
          .where(eq(schema.userCredentials.userId, user[0].id));
      } else {
        await tx.insert(schema.userCredentials).values({
          userId: user[0].id,
          passwordHash,
        });
      }

      await tx
        .update(schema.users)
        .set({ emailVerified: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.users.id, user[0].id), isNull(schema.users.emailVerified)));

      await tx.delete(schema.verificationTokens).where(eq(schema.verificationTokens.identifier, identifier));
    });

    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    return NextResponse.json({
      message: 'Password reset successful. You can now sign in with your new password.',
    });
  } catch (error) {
    console.error('Reset password error:', error);
    await consistentDelay(startTime, MIN_RESPONSE_TIME_MS);
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
