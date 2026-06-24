import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { sendPasswordResetEmail } from '@/app/lib/email/email-service';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';
import { getPasswordResetIdentifier } from '@/app/lib/auth/password-reset';

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const MIN_RESPONSE_TIME_MS = 1500;

async function consistentDelay(startTime: number): Promise<void> {
  const elapsed = Date.now() - startTime;
  const remaining = MIN_RESPONSE_TIME_MS - elapsed;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const genericMessage = 'If an account exists for this email, a reset link will be sent.';

  try {
    const clientIp = getClientIp(request);
    const rateLimitResult = checkRateLimit(`forgot-password:${clientIp}`, 5, 60_000);

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

    const body = await request.json();
    const validationResult = forgotPasswordSchema.safeParse(body);

    if (!validationResult.success) {
      await consistentDelay(startTime);
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const { email } = validationResult.data;
    const db = getDb();

    const user = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (user.length === 0) {
      await consistentDelay(startTime);
      return NextResponse.json({ message: genericMessage }, { status: 200 });
    }

    const hasCredentials = await db
      .select({ userId: schema.userCredentials.userId })
      .from(schema.userCredentials)
      .where(eq(schema.userCredentials.userId, user[0].id))
      .limit(1);

    if (hasCredentials.length === 0) {
      await consistentDelay(startTime);
      return NextResponse.json({ message: genericMessage }, { status: 200 });
    }

    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    const identifier = getPasswordResetIdentifier(email);

    await db.transaction(async (tx) => {
      await tx.delete(schema.verificationTokens).where(eq(schema.verificationTokens.identifier, identifier));

      await tx.insert(schema.verificationTokens).values({
        identifier,
        token,
        expires,
      });
    });

    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    await sendPasswordResetEmail(email, token, baseUrl);

    await consistentDelay(startTime);
    return NextResponse.json({ message: genericMessage }, { status: 200 });
  } catch (error) {
    console.error('Forgot password error:', error);
    await consistentDelay(startTime);
    return NextResponse.json({ error: 'Failed to process password reset request' }, { status: 500 });
  }
}
