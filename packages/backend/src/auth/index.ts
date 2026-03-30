import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { createPool } from '@boardsesh/db/client';
import { db } from '../db/client';
import { users, userCredentials, userProfiles, baAccounts } from '@boardsesh/db/schema/auth';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import type { BetterAuthOptions } from 'better-auth';

/**
 * Build social providers config conditionally based on available env vars.
 * Mirrors the pattern from packages/web/app/lib/auth/auth-options.ts
 */
function buildSocialProviders(): BetterAuthOptions['socialProviders'] {
  const providers: BetterAuthOptions['socialProviders'] = {};

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }

  if (process.env.APPLE_ID && process.env.APPLE_SECRET) {
    providers.apple = {
      clientId: process.env.APPLE_ID,
      clientSecret: process.env.APPLE_SECRET,
    };
  }

  if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
    providers.facebook = {
      clientId: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    };
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

/**
 * Migrate a user's credential from the legacy user_credentials table to
 * Better Auth's ba_accounts table. This is a one-time operation per user
 * that happens transparently on their first Better Auth sign-in.
 *
 * Returns true if migration was performed (or already existed), false if
 * the user has no legacy credentials.
 */
async function migrateCredentialIfNeeded(email: string): Promise<boolean> {
  try {
    // Find user by email
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) return false;

    // Check if Better Auth credential account already exists
    const [existingBaAccount] = await db
      .select({ id: baAccounts.id })
      .from(baAccounts)
      .where(
        and(
          eq(baAccounts.userId, user.id),
          eq(baAccounts.providerId, 'credential'),
        ),
      )
      .limit(1);

    if (existingBaAccount) return true; // Already migrated

    // Check for legacy credential in user_credentials
    const [legacyCred] = await db
      .select({ passwordHash: userCredentials.passwordHash })
      .from(userCredentials)
      .where(eq(userCredentials.userId, user.id))
      .limit(1);

    if (!legacyCred) return false; // No password credential

    // Create Better Auth credential account with the existing hash
    await db.insert(baAccounts).values({
      id: crypto.randomUUID(),
      userId: user.id,
      providerId: 'credential',
      accountId: user.id, // Better Auth uses the user ID as accountId for credentials
      password: legacyCred.passwordHash,
    }).onConflictDoNothing();

    console.log(`[BetterAuth] Migrated credential for user: ${user.id}`);
    return true;
  } catch (error) {
    console.error('[BetterAuth] Credential migration failed:', error);
    return false;
  }
}

/**
 * Better Auth instance configured for the backend server.
 *
 * Uses the shared users table with separate Better Auth tables for
 * accounts (ba_accounts), sessions (ba_sessions), and verifications
 * (ba_verifications) to allow dual-auth operation during the
 * NextAuth -> Better Auth transition.
 */
export const auth = betterAuth({
  // Base URL for the backend server
  baseURL: process.env.BETTER_AUTH_URL || process.env.BOARDSESH_URL || 'http://localhost:8080',

  // Auth API is mounted at /auth on the backend
  basePath: '/auth',

  // Use the existing NEXTAUTH_SECRET for consistency during transition,
  // or BETTER_AUTH_SECRET if explicitly set
  secret: process.env.BETTER_AUTH_SECRET || process.env.NEXTAUTH_SECRET,

  // Database: use the Neon serverless Pool (pg-compatible)
  database: createPool() as unknown as import('kysely').PostgresPool,

  // Map to existing users table
  user: {
    modelName: 'users',
    fields: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },

  // Use separate Better Auth accounts table because the existing NextAuth
  // accounts table has a compound PK (provider, providerAccountId) and is
  // missing columns (id, password, createdAt, updatedAt) Better Auth requires.
  account: {
    modelName: 'ba_accounts',
  },

  // Separate session table to avoid conflicts during transition
  session: {
    modelName: 'ba_sessions',
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // Refresh session every 24 hours
  },

  verification: {
    modelName: 'ba_verifications',
  },

  // Email/password auth with bcrypt (matching existing cost factor 12)
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    password: {
      hash: async (password: string): Promise<string> => {
        return bcrypt.hash(password, 12);
      },
      verify: async ({ hash, password }: { hash: string; password: string }): Promise<boolean> => {
        return bcrypt.compare(password, hash);
      },
    },
    requireEmailVerification: process.env.EMAIL_VERIFICATION_ENABLED === 'true',
    autoSignIn: true,
  },

  // Social providers (conditionally enabled based on env vars)
  socialProviders: buildSocialProviders(),

  // Trusted origins for CORS / CSRF
  trustedOrigins: [
    process.env.BOARDSESH_URL || 'https://boardsesh.com',
    'http://localhost:3000',
  ],

  // Cookie and advanced configuration
  advanced: {
    crossSubDomainCookies: {
      enabled: !!process.env.AUTH_COOKIE_DOMAIN,
      domain: process.env.AUTH_COOKIE_DOMAIN,
    },
    trustedProxyHeaders: process.env.NODE_ENV === 'production',
    disableCSRFCheck: false,
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },

  // Rate limiting (Better Auth built-in)
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/sign-up/email': { window: 60, max: 10 },
      '/sign-in/email': { window: 60, max: 20 },
      '/forgot-password': { window: 60, max: 5 },
    },
  },

  // Request hooks for credential migration and custom behavior
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Intercept email/password sign-in to migrate legacy credentials
      // from user_credentials table to ba_accounts table
      if (ctx.path === '/sign-in/email' && ctx.method === 'POST') {
        try {
          const body = ctx.body as { email?: string } | undefined;
          if (body?.email) {
            await migrateCredentialIfNeeded(body.email);
          }
        } catch (error) {
          console.error('[BetterAuth] Hook error on sign-in:', error);
        }
      }
    }),
  },

  // Database hooks for user lifecycle events
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Auto-create user_profiles entry for new users
          // (matching existing NextAuth createUser event behavior)
          if (user.id) {
            try {
              await db.insert(userProfiles).values({ userId: user.id }).onConflictDoNothing();
              console.log(`[BetterAuth] Created user profile for new user: ${user.id}`);
            } catch (error) {
              console.error('[BetterAuth] Failed to create user profile:', error);
            }
          }
        },
      },
    },
    account: {
      create: {
        after: async (account) => {
          // When Better Auth creates a credential account, also sync to
          // user_credentials table for backward compatibility with NextAuth
          if (account.providerId === 'credential' && account.password && account.userId) {
            try {
              await db
                .insert(userCredentials)
                .values({
                  userId: account.userId,
                  passwordHash: account.password,
                })
                .onConflictDoNothing();
              console.log(`[BetterAuth] Synced credential to user_credentials for user: ${account.userId}`);
            } catch (error) {
              console.error('[BetterAuth] Failed to sync credential:', error);
            }
          }
        },
      },
    },
  },
});

/** Cookie name used by Better Auth for session tokens */
export const BA_SESSION_COOKIE = 'better-auth.session_token';

/** Regex to extract Better Auth session token from a cookie string */
export const BA_SESSION_COOKIE_REGEX = /better-auth\.session_token=([^;]+)/;

/**
 * Validate a Better Auth session token (from cookie).
 * Returns the user ID if the session is valid, null otherwise.
 */
export async function validateBetterAuthSession(
  tokenValue: string,
): Promise<{ userId: string } | null> {
  try {
    const session = await auth.api.getSession({
      headers: new Headers({
        cookie: `${BA_SESSION_COOKIE}=${tokenValue}`,
      }),
    });

    if (session?.user?.id) {
      return { userId: session.user.id };
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      console.warn('[BetterAuth] Session validation failed:', error.message);
    }
    return null;
  }
}

/**
 * Validate a Better Auth session from an Authorization header bearer token.
 */
export async function validateBetterAuthBearer(
  bearerToken: string,
): Promise<{ userId: string } | null> {
  try {
    const session = await auth.api.getSession({
      headers: new Headers({
        authorization: `Bearer ${bearerToken}`,
      }),
    });

    if (session?.user?.id) {
      return { userId: session.user.id };
    }

    return null;
  } catch (error) {
    if (error instanceof Error) {
      console.warn('[BetterAuth] Bearer validation failed:', error.message);
    }
    return null;
  }
}

export type { BetterAuthOptions };
