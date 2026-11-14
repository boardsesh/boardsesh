import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { verifyProviderGoogleAuthenticationAssertion } from '../provider-google-reauthentication';
import { googleReauthenticationDeadline, type ProviderSecurityMethodsConfiguration } from '../provider-security-policy';

const configuration: ProviderSecurityMethodsConfiguration = {
  configuredProviders: ['google'],
  googleAudience: 'owned-google-web-client',
  googleReauthenticationEnabled: true,
};
const nonce = 'operation-bound-google-nonce';
const keyId = 'provider-security-google-key';
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let alternate: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  [pair, alternate] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
});
afterEach(() => vi.unstubAllGlobals());

async function token(claims: JWTPayload = {}, signingPair = pair) {
  const seconds = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: configuration.googleAudience!,
    sub: 'owned-google-subject',
    iat: seconds,
    exp: seconds + 600,
    auth_time: seconds - 120,
    nonce,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .sign(signingPair.privateKey);
}

async function useRealProviderVerifier() {
  const publicKey = { ...(await exportJWK(pair.publicKey)), kid: keyId, alg: 'RS256', use: 'sig' };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const address = input instanceof Request ? input.url : String(input);
    if (address !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('Unexpected provider fixture URL');
    return Response.json({ keys: [publicKey] });
  });
}

it('uses the pinned real verifier and preserves signed authentication time separately from token issuance', async () => {
  await useRealProviderVerifier();
  const seconds = Math.floor(Date.now() / 1000);
  const assertion = await verifyProviderGoogleAuthenticationAssertion(configuration, {
    idToken: await token({ auth_time: seconds - 299 }),
    nonce,
  });
  expect(assertion).toMatchObject({ subject: 'owned-google-subject', authenticatedAt: seconds - 299 });
  expect(
    googleReauthenticationDeadline(
      assertion?.authenticatedAt,
      assertion?.expiresAt,
      new Date((seconds + 2) * 1000),
      new Date((seconds + 600) * 1000),
    ),
  ).toBeNull();
});

it.each([
  ['wrong issuer', { iss: 'https://untrusted.example' }],
  ['wrong audience', { aud: 'foreign-client' }],
  ['wrong authorized party', { azp: 'foreign-client' }],
  ['wrong nonce', { nonce: 'different-operation' }],
  ['expired token', { exp: 1 }],
  ['missing auth_time', { auth_time: undefined }],
  ['string auth_time', { auth_time: 'recent' }],
  ['future authentication event', { auth_time: Math.floor(Date.now() / 1000) + 60 }],
] as const)('refuses %s without issuing any freshness receipt', async (_label, claims) => {
  await useRealProviderVerifier();
  expect(
    await verifyProviderGoogleAuthenticationAssertion(configuration, { idToken: await token(claims), nonce }),
  ).toBeNull();
});

it('refuses a token signed by a different provider key', async () => {
  await useRealProviderVerifier();
  expect(
    await verifyProviderGoogleAuthenticationAssertion(configuration, { idToken: await token({}, alternate), nonce }),
  ).toBeNull();
});

it('does not request provider keys until the supported claim configuration is explicitly selected', async () => {
  const unexpectedFetch = vi.fn(() => {
    throw new Error('Unexpected provider I/O');
  });
  vi.stubGlobal('fetch', unexpectedFetch);
  expect(
    await verifyProviderGoogleAuthenticationAssertion(
      { ...configuration, googleReauthenticationEnabled: false },
      { idToken: await token(), nonce },
    ),
  ).toBeNull();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});
