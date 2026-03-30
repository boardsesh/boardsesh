import { eq, and, isNull } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit } from '../shared/helpers';
import bcrypt from 'bcryptjs';

export interface SetPasswordResult {
  message: string;
}

export const setPasswordMutation = {
  setPassword: async (
    _: unknown,
    { password, confirmPassword }: { password: string; confirmPassword: string },
    ctx: ConnectionContext,
  ): Promise<SetPasswordResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 5, 'setPassword');

    const userId = ctx.userId!;

    // Validate
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    if (password.length > 128) {
      throw new Error('Password must be less than 128 characters');
    }
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }

    // Check if credentials already exist
    const existing = await db
      .select({ userId: dbSchema.userCredentials.userId })
      .from(dbSchema.userCredentials)
      .where(eq(dbSchema.userCredentials.userId, userId))
      .limit(1);

    if (existing.length > 0) {
      throw new Error('Password already set.');
    }

    // Hash password and insert
    const passwordHash = await bcrypt.hash(password, 12);

    try {
      // Insert credentials
      await db.insert(dbSchema.userCredentials).values({
        userId,
        passwordHash,
      });

      // Set emailVerified if null (OAuth users already have verified email)
      await db
        .update(dbSchema.users)
        .set({ emailVerified: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(dbSchema.users.id, userId),
            isNull(dbSchema.users.emailVerified),
          ),
        );
    } catch (insertError: unknown) {
      // Handle race condition (unique constraint violation)
      if (
        insertError &&
        typeof insertError === 'object' &&
        'code' in insertError &&
        (insertError as { code: string }).code === '23505'
      ) {
        throw new Error('Password already set.');
      }
      throw insertError;
    }

    return {
      message: 'Password set successfully. You can now log in with your email and password.',
    };
  },
};
