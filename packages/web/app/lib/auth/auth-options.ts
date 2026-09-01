import type { NextAuthOptions } from 'next-auth';
import { randomUUID } from 'node:crypto';
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
import { isSecureCookieContext, sessionCookieDomain } from '@/app/lib/auth/secure-cookies';
import { isAllowedAppOrigin } from '@/app/lib/auth/app-origin-allowlist';
import { applyCanonicalAuthUrl } from '@/app/lib/auth/canonical-auth-url';

// Must run before anything below reads NEXTAUTH_URL (the cookie block does, via
// isSecureCookieContext/sessionCookieDomain) and before next-auth resolves the
// origin it builds OAuth redirect URIs from. Without it, a hosted deployment
// with an unset or loopback NEXTAUTH_URL sends users to http://localhost:3000
// after a Google/Apple sign-in (issue #4227).
applyCanonicalAuthUrl();

// How long a JWT-cached profile avatar/name stays authoritative before the
// `jwt` callback re-reads userProfiles. A Settings edit refreshes it instantly
// (the client calls `update()` → `trigger: 'update'`); this TTL is only the
// safety net for changes made elsewhere (another device, a backend avatar
// swap). Long enough that ordinary browsing never re-queries the DB, short
// enough that out-of-band edits still surface within a few minutes.
const PROFILE_CLAIMS_TTL_MS = 5 * 60 * 1000;

const OAUTH_EMAIL_REQUIRED_ERROR = 'OAuthEmailRequired';
const OAUTH_EMAIL_REQUIRED_REDIRECT = `/auth/error?error=${OAUTH_EMAIL_REQUIRED_ERROR}`;
const OAUTH_TELEMETRY_PROVIDERS = new Set(['google', 'apple', 'facebook']);

function hasUsableEmail(email: string | null | undefined): email is string {
  return typeof email === 'string' && email.trim().length > 0;
}

function reportMissingOAuthEmail(provider: string): void {
  // Keep this a single JSON record so hosted logs can filter by event/provider.
  // The provider is allow-listed because an arbitrary identifier must never be
  // copied from an OAuth callback into telemetry.
  console.warn(
    JSON.stringify({
      event: 'oauth_sign_in_rejected',
      provider: OAUTH_TELEMETRY_PROVIDERS.has(provider) ? provider : 'unknown',
      error_code: OAUTH_EMAIL_REQUIRED_ERROR,
    }),
  );
}

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
      checks: ['pkce', 'state'],
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
//
// INTENTIONAL, REVIEWED: these four short-lived OAuth-flow cookies carry
// SameSite=None on the shared `.boardsesh.com` scope. They are NOT the login —
// they hold only in-flight CSRF/PKCE/nonce state consumed within a single OAuth
// round-trip, and each requires Secure. The session token itself stays
// SameSite=Lax (see the sessionToken block below); None is confined to these
// transient flow cookies so the actual login is never sent cross-site.
const useSecureCookies = isSecureCookieContext();

// Shared parent domain so the session (and the OAuth-flow cookies) are readable
// on every *.boardsesh.com subdomain — www.boardsesh.com sets the login, and the
// standalone Expo-web app at app.boardsesh.com reads it cross-origin. The domain
// is derived from the actual serving host (sessionCookieDomain): only the
// production www/apex host gets `.boardsesh.com`; localhost, Vercel previews
// (*.vercel.app would reject the Domain outright), and homelab preview hosts
// all stay host-only. Override with AUTH_COOKIE_DOMAIN if the parent domain
// ever differs from the prod default.
//
// SECURITY: with a `.boardsesh.com` Domain the session cookie is sent to *every*
// subdomain (kiosk, embed previews, `{N}.app.boardsesh.com`, any future
// subdomain), not just www + app. Any subdomain we serve can therefore read the
// logged-in user's HttpOnly session — keep untrusted/third-party content off
// *.boardsesh.com hosts.
const cookieDomain = sessionCookieDomain();

export const authOptions: NextAuthOptions = {
  adapter: DrizzleAdapter(getDb(), {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  providers,
  cookies: {
    // The session token is the login itself. SameSite=Lax (NOT None) is correct
    // here: app.boardsesh.com and www.boardsesh.com are the same SITE
    // (registrable domain boardsesh.com), so Lax cookies ARE sent on
    // cross-subdomain requests — no need for the weaker SameSite=None. `secure`
    // stays true in secure contexts and the `__Secure-` prefix (which permits a
    // Domain attribute) is kept so the name still matches what getToken reads.
    sessionToken: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.session-token`,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        domain: cookieDomain,
      },
    },
    callbackUrl: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.callback-url`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
        domain: cookieDomain,
      },
    },
    state: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.state`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
        domain: cookieDomain,
      },
    },
    nonce: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.nonce`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
        domain: cookieDomain,
      },
    },
    pkceCodeVerifier: {
      name: `${useSecureCookies ? '__Secure-' : ''}next-auth.pkce.code_verifier`,
      options: {
        httpOnly: true,
        sameSite: useSecureCookies ? 'none' : 'lax',
        path: '/',
        secure: useSecureCookies,
        domain: cookieDomain,
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
    // Replace NextAuth's built-in GET /api/auth/signout confirmation page. Its
    // form POSTs only a CSRF token, which the identity-guarded signout route now
    // rejects with 400. This page drives the guarded sign-out sequence instead.
    signOut: '/auth/signout',
  },
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Mirror NextAuth's default resolution (relative → baseUrl-prefixed;
      // same-origin → as-is; anything else → baseUrl) and ADDITIONALLY allow the
      // standalone Expo-web app's own origin. Without this, a sign-in/sign-out
      // started on app.boardsesh.com passes a cross-origin `callbackUrl`, which
      // the default callback would coerce to the www base origin — and the app's
      // sign-out confirmation (which compares the returned URL's origin+path to
      // its own app-origin callback) would then mismatch and throw. Restricted
      // to the same anchored app allow-list the CORS layer uses, so every other
      // cross-origin URL still collapses to baseUrl (open-redirect guard).
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      try {
        // Compare origins, not the raw baseUrl string. baseUrl mirrors
        // NEXTAUTH_URL verbatim and may carry a trailing slash or path, so a
        // literal `targetOrigin === baseUrl` check misses a genuine same-origin
        // redirect and strips it to the base. `new URL(baseUrl).origin` is
        // scheme+host only, matching what `new URL(url).origin` returns.
        const baseOrigin = new URL(baseUrl).origin;
        const targetOrigin = new URL(url).origin;
        if (targetOrigin === baseOrigin) return url;
        if (isAllowedAppOrigin(targetOrigin)) return url;
      } catch {
        // Unparseable URL falls through to the safe baseUrl default.
      }
      return baseUrl;
    },
    async signIn({ user, account }) {
      // OAuth providers - allow sign in (emails are pre-verified by provider)
      // Skip native-oauth (transfer token flow) — email is already verified
      if (account?.provider !== 'credentials' && account?.provider !== 'native-oauth') {
        // NextAuth runs this callback before its adapter creates or links an
        // OAuth user. Rejecting here prevents a provider profile with no email
        // from reaching either this callback's verification update or the
        // adapter's users insert (users.email is intentionally NOT NULL).
        // For an already-linked account NextAuth supplies the stored user here,
        // so providers that omit email on later callbacks continue to work.
        if (!hasUsableEmail(user.email)) {
          reportMissingOAuthEmail(account?.provider ?? 'unknown');
          return OAUTH_EMAIL_REQUIRED_REDIRECT;
        }

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

      // For credentials, check if email is verified
      if (!user.email) {
        return false;
      }

      const db = getDb();
      const existingUser = await db.select().from(schema.users).where(eq(schema.users.email, user.email)).limit(1);

      // Check if email verification is enabled (disabled by default until Fastmail auth is set up)
      const emailVerificationEnabled = process.env.EMAIL_VERIFICATION_ENABLED === 'true';
      if (emailVerificationEnabled && existingUser.length > 0 && !existingUser[0].emailVerified) {
        // Redirect to verification page with error
        return '/auth/verify-request?error=EmailNotVerified';
      }

      return true;
    },
    async session({ session, token }) {
      if (typeof token.authSessionId === 'string' && token.authSessionId) {
        session.authSessionId = token.authSessionId;
      }
      // Include user ID in session from JWT
      if (session?.user && token?.sub) {
        session.user.id = token.sub;

        // Custom avatar/display name come off the JWT, which the `jwt` callback
        // keeps fresh (sign-in, Settings `update()`, or a TTL refresh) — so a
        // session read no longer runs a userProfiles DB query on every call.
        if (token.profileAvatarUrl) {
          session.user.image = token.profileAvatarUrl;
        }
        if (token.profileDisplayName) {
          session.user.name = token.profileDisplayName;
        }
      }
      return session;
    },
    async jwt({ token, user, trigger }) {
      // Stable for one NextAuth login across cookie rotations and tabs, but new
      // for a later login even when it belongs to the same user. Existing JWTs
      // can reuse their standard jti so rollout does not force a sign-out.
      if (!token.authSessionId) {
        token.authSessionId = typeof token.jti === 'string' && token.jti ? token.jti : randomUUID();
      }
      // Persist the OAuth access_token and user id to the token right after signin
      if (user) {
        token.id = user.id;
      }

      // Cache the userProfiles avatar/display name ON the token so the `session`
      // callback (which runs on every /api/auth/session read — each page load,
      // plus NextAuth's client polling) doesn't hit the DB every time. Refresh
      // on sign-in (`user`), on an explicit `update()` after a Settings edit
      // (`trigger === 'update'`), or when the cache has aged past the TTL;
      // otherwise the previously cached claims stand.
      const profileCacheStale =
        typeof token.profileClaimsRefreshedAt !== 'number' ||
        Date.now() - token.profileClaimsRefreshedAt > PROFILE_CLAIMS_TTL_MS;
      if (token.sub && (Boolean(user) || trigger === 'update' || profileCacheStale)) {
        try {
          const db = getDb();
          const profiles = await db
            .select({ avatarUrl: schema.userProfiles.avatarUrl, displayName: schema.userProfiles.displayName })
            .from(schema.userProfiles)
            .where(eq(schema.userProfiles.userId, token.sub))
            .limit(1);
          token.profileAvatarUrl = profiles[0]?.avatarUrl ?? null;
          token.profileDisplayName = profiles[0]?.displayName ?? null;
          token.profileClaimsRefreshedAt = Date.now();
        } catch (error) {
          // Keep whatever claims are already cached rather than failing the
          // whole token read — a briefly stale avatar/name is fine; a broken
          // session (signed-out header, failed page load) is not.
          console.warn('Failed to refresh profile claims for session JWT:', error);
        }
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
