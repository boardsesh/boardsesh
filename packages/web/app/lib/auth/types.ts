import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface Session {
    authSessionId?: string;
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface JWT {
    authSessionId?: string;
    // Cached userProfiles claims so the `session` callback doesn't run a DB
    // query on every /api/auth/session read. `null` means "fetched, but the
    // profile has none" (distinct from `undefined` = never fetched yet).
    // `profileClaimsRefreshedAt` is an epoch-ms timestamp gating the TTL refresh.
    profileAvatarUrl?: string | null;
    profileDisplayName?: string | null;
    profileClaimsRefreshedAt?: number;
  }
}
