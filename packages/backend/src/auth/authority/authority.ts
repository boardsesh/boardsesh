import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { compare, hash } from 'bcryptjs';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import { createAuthorityAdapter, type AuthorityTransaction } from './adapter';

export interface AuthorityConfiguration {
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
}

export function verifyAuthorityPassword({
  hash: passwordHash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  return compare(password, passwordHash);
}

/** Unmounted first-party authority. No OAuth provider, import, mirror, or writer switch. */
export function createAuthority(database: AuthorityTransaction, configuration: AuthorityConfiguration) {
  const options = {
    appName: 'Boardsesh',
    ...configuration,
    database: createAuthorityAdapter(database),
    emailAndPassword: {
      enabled: true,
      password: {
        hash: (password: string) => hash(password, PASSWORD_HASH_COST),
        verify: verifyAuthorityPassword,
      },
    },
    session: {
      freshAge: 5 * 60,
      cookieCache: { enabled: false },
      additionalFields: {
        originalAuthenticatedAt: { type: 'date', required: false, input: false },
        legacyLineageId: { type: 'string', required: false, input: false },
        revocationGeneration: { type: 'number', required: false, input: false },
      },
    },
    account: { accountLinking: { enabled: false } },
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    telemetry: { enabled: false },
    logger: { disabled: true },
  } satisfies BetterAuthOptions;
  return betterAuth(options);
}
