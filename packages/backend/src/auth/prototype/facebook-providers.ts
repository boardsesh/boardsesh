import type { BetterAuthOptions } from 'better-auth';
import { PROTOTYPE_ISSUER } from './oauth-options';

export const PROTOTYPE_FACEBOOK_CLIENT_ID = 'boardsesh-ba01-synthetic-facebook-app';
export const PROTOTYPE_FACEBOOK_CLIENT_SECRET = 'boardsesh-ba01-synthetic-facebook-secret';
export const PROTOTYPE_FACEBOOK_CALLBACK_URL = `${PROTOTYPE_ISSUER}/callback/facebook`;

export interface PrototypeStoredFacebookIdentity {
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
}

/**
 * Disposable browser-provider configuration. On the exercised opaque-token
 * Graph path, the pinned provider verifies /debug_token app/user binding and the
 * Graph profile subject before this documented hook. Limited Login ID-token
 * behavior is outside this proof. Never resolve an imported subject by email.
 */
export function createFacebookPrototypeOptions(
  findFacebookIdentity: (subject: string) => Promise<PrototypeStoredFacebookIdentity | null>,
): Pick<BetterAuthOptions, 'socialProviders' | 'account' | 'advanced'> {
  return {
    // Better Auth otherwise bypasses origin checks automatically in test mode.
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    account: { accountLinking: { enabled: false } },
    socialProviders: {
      facebook: {
        clientId: PROTOTYPE_FACEBOOK_CLIENT_ID,
        clientSecret: PROTOTYPE_FACEBOOK_CLIENT_SECRET,
        redirectURI: PROTOTYPE_FACEBOOK_CALLBACK_URL,
        async mapProfileToUser(profile) {
          if (profile.email) return {};
          const subject = 'sub' in profile ? profile.sub : profile.id;
          const existingIdentity = await findFacebookIdentity(subject);
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
