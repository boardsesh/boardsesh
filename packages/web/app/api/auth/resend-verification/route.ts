import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { sendVerificationEmail } from '@/app/lib/email/email-service';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';

// Zod schema for email validation
const resendVerificationSchema = z.object({
  email: z.string().email('Invalid email address'),
});

// Minimum response time to prevent timing attacks
// Balances security (covering typical email send variance) with UX
const MIN_RESPONSE_TIME_MS = 1500;

// Helper to introduce consistent delay to prevent timing attacks
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
    // Rate limiting - 5 requests per minute per IP
    const clientIp = getClientIp(request);
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

    const body = await request.json();

    // Validate input with Zod
    const validationResult = resendVerificationSchema.safeParse(body);
    if (!validationResult.success) {
      await consistentDelay(startTime);
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const { email } = validationResult.data;
    const db = getDb();

    // Check if user exists and is unverified
    const user = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);

    // Don't reveal user status - return same message for all cases
    // Use consistent delay for all paths to prevent timing attacks
    if (user.length === 0 || user[0].emailVerified) {
      await consistentDelay(startTime);
      return NextResponse.json({ message: genericMessage }, { status: 200 });
    }

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

    const baseUrl = request.nextUrl.origin;
    await sendVerificationEmail(email, token, baseUrl);

    await consistentDelay(startTime);
    return NextResponse.json({ message: genericMessage }, { status: 200 });
  } catch (error) {
    console.error('Resend verification error:', error);
    await consistentDelay(startTime);
    return NextResponse.json({ error: 'Failed to send verification email' }, { status: 500 });
  }
}
