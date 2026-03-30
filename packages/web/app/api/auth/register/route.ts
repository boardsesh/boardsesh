import { type NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { sendVerificationEmail } from '@/app/lib/email/email-service';
import { checkRateLimit, getClientIp } from '@/app/lib/auth/rate-limiter';

const emailVerificationEnabled = process.env.EMAIL_VERIFICATION_ENABLED === 'true';

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be less than 128 characters'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters').optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Rate limiting - 10 requests per minute per IP for registration
    const clientIp = getClientIp(request);
    const rateLimitResult = checkRateLimit(`register:${clientIp}`, 10, 60_000);

    if (rateLimitResult.limited) {
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

    // Validate input
    const validationResult = registerSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json({ error: validationResult.error.issues[0].message }, { status: 400 });
    }

    const { password, name } = validationResult.data;
    const email = validationResult.data.email.toLowerCase().trim();
    const db = getDb();

    // Check if user already exists
    const existingUser = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);

    if (existingUser.length > 0) {
      // An account with this email already exists
      // Do not allow registering again - user should use their existing authentication method
      // This prevents account takeover attacks where someone registers with an OAuth user's email
      return NextResponse.json(
        {
          error: 'An account with this email already exists. Please sign in with your existing account.',
        },
        { status: 409 },
      );
    }

    // Create new user
    const userId = crypto.randomUUID();
    const passwordHash = await hash(password, 12);
    const verificationToken = emailVerificationEnabled ? crypto.randomUUID() : null;
    const tokenExpires = emailVerificationEnabled ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null; // 24 hours

    // Use transaction to ensure user, credentials, profile, and token are created atomically
    // If any insert fails, all changes are rolled back
    try {
      await db.transaction(async (tx) => {
        // Insert user (emailVerified is null if verification enabled, otherwise auto-verified)
        await tx.insert(schema.users).values({
          id: userId,
          email,
          name: name || email.split('@')[0],
          emailVerified: emailVerificationEnabled ? null : new Date(),
        });

        // Insert credentials
        await tx.insert(schema.userCredentials).values({
          userId,
          passwordHash,
        });

        // Create empty profile (user can customize later)
        await tx.insert(schema.userProfiles).values({
          userId,
        });

        // Insert verification token if email verification is enabled
        if (emailVerificationEnabled && verificationToken && tokenExpires) {
          await tx.insert(schema.verificationTokens).values({
            identifier: email,
            token: verificationToken,
            expires: tokenExpires,
          });
        }
      });
    } catch (insertError) {
      // Handle race condition: another request created this user between our check and insert
      // PostgreSQL unique constraint violation code is '23505'
      if (insertError && typeof insertError === 'object' && 'code' in insertError && insertError.code === '23505') {
        return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
      }
      throw insertError;
    }

    // Send verification email if enabled
    if (emailVerificationEnabled && verificationToken) {
      const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';
      let emailSent = false;
      try {
        await sendVerificationEmail(email, verificationToken, baseUrl);
        emailSent = true;
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
        // User is created, they can use resend functionality
      }

      return NextResponse.json(
        {
          message: emailSent
            ? 'Account created. Please check your email to verify your account.'
            : 'Account created. Please request a new verification email.',
          requiresVerification: true,
          emailSent,
        },
        { status: 201 },
      );
    }

    // Email verification disabled - user can log in immediately
    return NextResponse.json(
      {
        message: 'Account created. You can now log in.',
        requiresVerification: false,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json({ error: 'An error occurred during registration' }, { status: 500 });
  }
}
