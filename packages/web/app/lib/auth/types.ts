import type { DefaultSession } from 'next-auth';
import type { AccountCreationReceipt } from '@boardsesh/analytics';

export type NativeOAuthCreationProof = {
  authSessionId: string;
  provider: 'apple' | 'google';
  signedInAt: number;
  accountCreation: AccountCreationReceipt;
};

declare module 'next-auth' {
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface Session {
    authSessionId?: string;
    nativeOAuthCreationProof?: NativeOAuthCreationProof;
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface JWT {
    authSessionId?: string;
    nativeOAuthCreationProof?: NativeOAuthCreationProof;
    // Epoch seconds of the sign-in that produced this cookie. Absent on cookies
    // from before the claim and on native transfer sign-ins: age unknown.
    auth_time?: number;
    // auth_subject_cutoffs.generation read when this login signed in, 0 with no
    // row. A rotation keeps it; a cookie from before the claim gets 0, the only
    // generation it can have been signed in under. Not read yet (BA-04 PR 2).
    gen?: number;
    // Set beside auth_time only by a sign-in made while OAuth account links were
    // guarded (PARTNER_OAUTH_MODE not off). Partner consent requires it.
    link_guarded?: true;
    // Cached userProfiles claims so the `session` callback doesn't run a DB
    // query on every /api/auth/session read. `null` means "fetched, but the
    // profile has none" (distinct from `undefined` = never fetched yet).
    // `profileClaimsRefreshedAt` is an epoch-ms timestamp gating the TTL refresh.
    profileAvatarUrl?: string | null;
    profileDisplayName?: string | null;
    profileClaimsRefreshedAt?: number;
  }
}
