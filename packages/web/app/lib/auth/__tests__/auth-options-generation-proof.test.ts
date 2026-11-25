// @vitest-environment node
/**
 * #7596 B2c, STAGED_WEB_PROOF_GENERATION_STAMP: under
 * `AUTH_BROWSER_SESSION_MODE=better-auth` the NextAuth `jwt` callback never
 * stamps a sign-in from www's own generation read; only a backend proof names
 * it. Default password sign-in also requires its actual backend proof.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import '../../../../auth-proofs/legacy-credential-fixture';

const generationReads = vi.hoisted(() => ({ count: 0 }));
vi.hoisted(() => {
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  process.env.NEXTAUTH_SECRET = 'auth-options-generation-proof-fixture-secret';
});
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (fields && Object.hasOwn(fields, 'generation')) generationReads.count += 1;
            return [];
          },
        }),
      }),
    }),
  }),
}));

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

  it.each([undefined, '', 'legacy'])(
    'refuses a bare password user under session mode %j without a generation read',
    async (mode) => {
      if (mode !== undefined) vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
      vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
      await expect(jwt(passwordSignIn())).rejects.toThrow('Backend web credential proof required');
      expect(generationReads.count).toBe(0);
    },
  );
  it('keeps the backend password generation, SID and actual auth time without a current-generation lookup', async () => {
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
    const authenticatedAt = '2026-11-24T01:02:03.000Z';
    const claims = await jwt({
      ...passwordSignIn(),
      user: {
        id: 'climber-1',
        webCredentialProof: {
          version: 1,
          userId: 'climber-1',
          authSessionId: 'proved-password-login',
          generation: 4,
          authenticatedAt,
          linkGuarded: true,
        },
      },
    });
    expect(claims).toMatchObject({
      gen: 4,
      authSessionId: 'proved-password-login',
      auth_time: Date.parse(authenticatedAt) / 1000,
    });
    expect(generationReads.count).toBe(0);
  });
  it.each([null, '2026-11-23T01:02:03.000Z'])(
    'preserves native transfer known/unknown authentication age %s',
    async (authenticatedAt) => {
      vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'legacy');
      vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
      const claims = await jwt({
        token: { sub: 'climber-1' },
        user: {
          id: 'climber-1',
          nativeOAuthSourceGeneration: 4,
          webCredentialProof: {
            version: 1,
            userId: 'climber-1',
            authSessionId: 'carried-login',
            generation: 4,
            authenticatedAt,
            linkGuarded: authenticatedAt !== null,
            requiresAccountCutoff: true,
          },
        },
        account: { provider: 'native-oauth', type: 'credentials', providerAccountId: 'climber-1' },
      });
      expect(claims).toMatchObject({ gen: 4, authSessionId: 'carried-login', legacy_no_sid: true });
      expect(claims.auth_time).toBe(authenticatedAt === null ? undefined : Date.parse(authenticatedAt) / 1000);
      expect(generationReads.count).toBe(0);
    },
  );
  it('preserves an older native transfer without a password proof or invented authentication time', async () => {
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'off');
    const claims = await jwt({
      token: { sub: 'climber-1' },
      user: { id: 'climber-1', nativeOAuthSourceGeneration: 4 },
      account: { provider: 'native-oauth', type: 'credentials', providerAccountId: 'climber-1' },
    });
    expect(claims.gen).toBe(4);
    expect(claims.auth_time).toBeUndefined();
    expect(generationReads.count).toBe(0);
  });
});
