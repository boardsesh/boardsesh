import type { NextAuthOptions } from 'next-auth';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import GoogleProvider from 'next-auth/providers/google';
import AppleProvider from 'next-auth/providers/apple';
import FacebookProvider from 'next-auth/providers/facebook';
import CredentialsProvider from 'next-auth/providers/credentials';
import { getDb } from '@/app/lib/db/db';
import * as schema from '@/app/lib/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { compare } from 'bcryptjs';
import { verifyNativeOAuthTransferToken } from '@/app/lib/auth/native-oauth-transfer';
import { isSecureCookieContext } from '@/app/lib/auth/secure-cookies';

// Build providers array conditionally based on available env vars
const providers: NextAuthOptions['providers'] = [];

// Only add Google provider if credentials are configured
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  );
}

// Only add Apple provider if credentials are configured
if (process.env.APPLE_ID && process.env.APPLE_SECRET) {
  providers.push(
    AppleProvider({
      clientId: process.env.APPLE_ID,
      clientSecret: process.env.APPLE_SECRET,
      checks: ['pkce'],
      allowDangerousEmailAccountLinking: true,
    }),
  );
}

// Only add Facebook provider if credentials are configured
if (process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET) {
  providers.push(
    FacebookProvider({
      clientId: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  );
}

// Always add credentials provider
providers.push(
  CredentialsProvider({
    id: 'native-oauth',
    name: 'Native OAuth',
    credentials: {
      transferToken: { label: 'Transfer Token', type: 'text' },
    },
    async authorize(credentials) {
      if (!credentials?.transferToken) {
        return null;
      }

      const decoded = verifyNativeOAuthTransferToken(credentials.transferToken);
      if (!decoded) {
        return null;
      }

      const db = getDb();
      const users = await db.select().from(schema.users).where(eq(schema.users.id, decoded.userId)).limit(1);

      if (users.length === 0) {
        return null;
      }

      const user = users[0];
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      };
    },
  }),
);

// Always add email/password credentials provider
providers.push(
  CredentialsProvider({
    name: 'Email',
    credentials: {
      email: { label: 'Email', type: 'email', placeholder: 'your@email.com' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) {
        return null;
      }

      const db = getDb();

      // Look up user by email
      const users = await db.select().from(schema.users).where(eq(schema.users.email, credentials.email)).limit(1);

      if (users.length === 0) {
        return null;
      }

      const user = users[0];

      // Get user credentials (password hash)
      const userCredentials = await db
        .select()
        .from(schema.userCredentials)
        .where(eq(schema.userCredentials.userId, user.id))
        .limit(1);

      if (userCredentials.length === 0) {
        // User exists but has no password (e.g., OAuth only)
        return null;
      }

      // Verify password
      const isValidPassword = await compare(credentials.password, userCredentials[0].passwordHash);

      if (!isValidPassword) {
        return null;
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      };
    },
  }),
);

// Apple Sign-In posts its callback cross-origin (response_mode=form_post),
// so verification cookies need SameSite=None (which requires Secure).
// We override callbackUrl, state, nonce, and pkceCodeVerifier cookies for this reason.
const useSecureCookies = isSecureCookieContext();

export const authOptions: NextAuthOptions = {
  adapter: DrizzleAdapter(getDb(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  providers,
  cookies: {
    callbackUrl: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.callback-url`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
      },
    },
    state: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.state`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
      },
    },
    nonce: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.nonce`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
      },
    },
    pkceCodeVerifier: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.pkce.code_verifier`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
      },
    },
  },
  session: {
    strategy: 'jwt', // Required for credentials provider
  },
  pages: {
    signIn: '/auth/login',
    verifyRequest: '/auth/verify-request',
    error: '/auth/error',
  },
  callbacks: {
    async signIn({ user, account }) {
      // OAuth providers - allow sign in (emails are pre-verified by provider)
      // Skip native-oauth (transfer token flow) — email is already verified
      if (account?.provider !== 'credentials' && account?.provider !== 'native-oauth') {
        // Mark email as verified if not already (provider already verified it)
        if (user.id) {
          try {
            const db = getDb();
            await db
              .update(schema.users)
              .set({ emailVerified: new Date() })
              .where(and(eq(schema.users.id, user.id), isNull(schema.users.emailVerified)));
          } catch (error) {
            // Best-effort — don't block sign-in if this fails
            console.warn('Failed to mark email as verified during OAuth sign-in:', error);
          }
        }
        return true;
      }

      // Native OAuth transfer tokens — already authenticated, allow through
      if (account?.provider === 'native-oauth') {
        return true;
      }

      // For credentials, just verify we have an email
      if (!user.email) {
        return false;
      }

      // Email verification is non-blocking — credentials users sign in regardless of
      // verified status. Verification emails (when SMTP is configured) are informational.
      return true;
    },
    async session({ session, token }) {
      // Include user ID in session from JWT
      if (session?.user && token?.sub) {
        session.user.id = token.sub;

        // Fetch custom avatar from userProfiles so the drawer/header show the current avatar
        const db = getDb();
        const profiles = await db
          .select({ avatarUrl: schema.userProfiles.avatarUrl })
          .from(schema.userProfiles)
          .where(eq(schema.userProfiles.userId, token.sub))
          .limit(1);
        if (profiles[0]?.avatarUrl) {
          session.user.image = profiles[0].avatarUrl;
        }
      }
      return session;
    },
    async jwt({ token, user }) {
      // Persist the OAuth access_token and user id to the token right after signin
      if (user) {
        token.id = user.id;
      }
      return token;
    },
  },
  events: {
    async createUser({ user }) {
      // Create profile for new OAuth users
      if (user.id) {
        const db = getDb();
        await db
          .insert(schema.userProfiles)
          .values({
            userId: user.id,
          })
          .onConflictDoNothing();
      }
    },
  },
};
