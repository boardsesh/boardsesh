// @vitest-environment node
/**
 * #7596 B2c, STAGED_WEB_PROOF_GENERATION_STAMP: under
 * `AUTH_BROWSER_SESSION_MODE=better-auth` the NextAuth `jwt` callback never
 * stamps a sign-in from www's own generation read; only a backend proof names
 * it. With the mode unset or `legacy` the fallback read runs as before.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import '../../../../auth-proofs/legacy-credential-fixture';

const generationReads = vi.hoisted(() => ({ count: 0 }));
vi.hoisted(() => {
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  process.env.NEXTAUTH_SECRET = 'auth-options-generation-proof-fixture-secret';
});
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => {
  const limit = async () => {
    generationReads.count += 1;
    return [];
  };
  return { getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit }) }) }) }) };
});

import { authOptions } from '../auth-options';

type JwtParameters = Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>>[0];
const jwt = (parameters: Partial<JwtParameters>) => {
  const callback = authOptions.callbacks?.jwt;
  if (!callback) throw new Error('auth-options has no jwt callback');
  return callback(parameters as JwtParameters);
};
const passwordSignIn = (): Partial<JwtParameters> => ({
  token: { sub: 'climber-1' },
  user: { id: 'climber-1' },
  account: { provider: 'credentials', type: 'credentials', providerAccountId: 'climber-1' },
});

afterEach(() => {
  vi.unstubAllEnvs();
  generationReads.count = 0;
});

describe('the sign-in generation without a backend proof', () => {
  it.each(['better-auth', 'Better-Auth'])(
    'is refused under AUTH_BROWSER_SESSION_MODE=%s, before any read',
    async (mode) => {
      vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
      vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
      await expect(jwt(passwordSignIn())).rejects.toThrow('Backend web credential proof required');
      expect(generationReads.count).toBe(0);
    },
  );

  it.each([undefined, '', 'legacy'])('is read and stamped as before with the mode %j', async (mode) => {
    if (mode !== undefined) vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
    const claims = await jwt(passwordSignIn());
    expect(claims.gen).toBe(0);
    expect(generationReads.count).toBeGreaterThan(0);
  });
});
