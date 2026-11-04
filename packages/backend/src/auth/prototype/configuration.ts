import type { BetterAuthOptions } from 'better-auth';
import { compare, hash } from 'bcryptjs';
import { PROTOTYPE_ISSUER } from './oauth-options';

/** Synthetic secrets and origins. This configuration is never a production authority. */
export const PROTOTYPE_CONFIGURATION = {
  appName: 'Boardsesh BA-01 prototype',
  baseURL: PROTOTYPE_ISSUER,
  secret: 'boardsesh-disposable-auth-prototype-secret-6975',
  trustedOrigins: ['https://auth.boardsesh.test', 'https://www.boardsesh.test'],
  emailAndPassword: {
    enabled: true,
    password: {
      hash: (password: string) => hash(password, 12),
      verify: ({ hash: passwordHash, password }: { hash: string; password: string }) => compare(password, passwordHash),
    },
  },
  user: {
    additionalFields: {
      legacyEmailVerifiedAt: { type: 'date', required: false, input: false },
    },
  },
  session: {
    freshAge: 5 * 60,
    cookieCache: { enabled: false },
    additionalFields: {
      originalAuthenticatedAt: { type: 'date', required: false, input: false },
      legacyLineageId: { type: 'string', required: false, input: false },
    },
  },
  account: { accountLinking: { enabled: false } },
  rateLimit: { enabled: false },
  telemetry: { enabled: false },
  logger: { disabled: true },
} satisfies BetterAuthOptions;
