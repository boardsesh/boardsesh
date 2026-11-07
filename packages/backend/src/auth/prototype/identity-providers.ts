import type { BetterAuthOptions } from 'better-auth';

export const PROTOTYPE_GOOGLE_AUDIENCES = [
  'prototype-web.apps.googleusercontent.com',
  'prototype-ios.apps.googleusercontent.com',
  'prototype-android.apps.googleusercontent.com',
];
export const PROTOTYPE_APPLE_AUDIENCES = ['com.boardsesh.prototype', 'com.boardsesh.prototype.web'];

export interface PrototypeStoredAppleIdentity {
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
}

/**
 * Only synthetic clients are configured here. Better Auth verifies the provider
 * token before invoking mapProfileToUser; the lookup must use its signed subject.
 * Matching email is never evidence to attach a previously unknown provider.
 */
export function createIdentityPrototypeOptions(
  findAppleIdentity: (subject: string) => Promise<PrototypeStoredAppleIdentity | null>,
): Pick<BetterAuthOptions, 'socialProviders' | 'account'> {
  return {
    account: { accountLinking: { enabled: false } },
    socialProviders: {
      google: {
        clientId: PROTOTYPE_GOOGLE_AUDIENCES,
        clientSecret: 'prototype-google-secret-not-used-for-id-token-login',
      },
      apple: {
        clientId: PROTOTYPE_APPLE_AUDIENCES,
        clientSecret: 'prototype-apple-secret-not-used-for-id-token-login',
        audience: PROTOTYPE_APPLE_AUDIENCES,
        async mapProfileToUser(profile) {
          if (profile.email) return {};
          const existingIdentity = await findAppleIdentity(profile.sub);
          if (!existingIdentity) return {};
          return {
            email: existingIdentity.email,
            name: existingIdentity.name,
            emailVerified: existingIdentity.emailVerified,
          };
        },
      },
    },
  };
}
