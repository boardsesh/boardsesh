import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import { unavailableCredentialResponse } from '@/app/lib/auth/credential-admission-response.server';
import { getAdmittedServerSession } from '@/app/lib/auth/admitted-session.server';
import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { hash } from 'bcryptjs';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import { eq, and, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';

const setPasswordSchema = z
  .object({
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

export async function POST(request: NextRequest) {
  try {
    const session = await getAdmittedServerSession();

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limiting - 5 requests per minute per IP
    const clientIp = getClientIp(request);
    const ipRateLimit = checkRateLimit(`set-password:${clientIp}`, 5, 60_000);
    if (ipRateLimit.limited) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(ipRateLimit.retryAfterSeconds) },
        },
      );
    }

    // Also rate limit by user ID
    const userRateLimit = checkRateLimit(`set-password:user:${session.user.id}`, 5, 60_000);
    if (userRateLimit.limited) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(userRateLimit.retryAfterSeconds) },
        },
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Validate input
    const validationResult = setPasswordSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const { password } = validationResult.data;
    const db = getDb();

    // Check if credentials already exist
    const existing = await db
      .select({ userId: schema.userCredentials.userId })
      .from(schema.userCredentials)
      .where(eq(schema.userCredentials.userId, session.user.id))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ error: 'Password already set.' }, { status: 409 });
    }

    // Hash password and insert
    const passwordHash = await hash(password, PASSWORD_HASH_COST);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(schema.userCredentials).values({
          userId: session.user.id,
          passwordHash,
        });

        // OAuth providers verify the email before allowing sign-in, so if this
        // user authenticated via OAuth and is now adding a password, their email
        // is already verified. Set emailVerified only if currently null.
        await tx
          .update(schema.users)
          .set({ emailVerified: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.users.id, session.user.id), isNull(schema.users.emailVerified)));
      });
    } catch (insertError) {
      // Handle race condition: another request inserted credentials between our check and insert
      if (insertError && typeof insertError === 'object' && 'code' in insertError && insertError.code === '23505') {
        return NextResponse.json({ error: 'Password already set.' }, { status: 409 });
      }
      throw insertError;
    }

    return NextResponse.json({
      message: 'Password set successfully. You can now log in with your email and password.',
    });
  } catch (error) {
    if (error instanceof CredentialAuthorityUnavailable) return unavailableCredentialResponse();
    console.error('Set password error:', error);
    return NextResponse.json({ error: 'An error occurred while setting the password' }, { status: 500 });
  }
}
