import 'server-only';
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { authOptions } from './auth-options';
import type { ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { GOOGLE_FORCED_REAUTHENTICATION } from './google-forced-reauthentication';
import type { ProviderFlowRoundTrip } from './provider-flow-cookie.server';

/**
 * The OpenID Connect round trips of provider link and Google reauthentication
 * (#7596 B5e1), outside NextAuth: www's own start route and callback, so no
 * sign-in callback can finish one of these flows and the reverse. Endpoints and
 * client credentials come from the providers NextAuth is configured with (one
 * source of configuration); nothing here writes a cookie.
 *
 * Every round trip uses state, nonce and PKCE (S256), each 256 random bits,
 * all kept in the sealed flow cookie. The ID token from the token endpoint is
 * verified here (RS256 signature against the issuer's keys, issuer, audience,
 * authorized party, expiry, issue time, nonce) before anything is believed.
 */

const ISSUERS: Readonly<Record<ProviderSecurityProvider, readonly string[]>> = Object.freeze({
  google: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
  apple: Object.freeze(['https://appleid.apple.com']),
});
const DEFAULT_DISCOVERY: Readonly<Record<ProviderSecurityProvider, string>> = Object.freeze({
  google: 'https://accounts.google.com/.well-known/openid-configuration',
  apple: 'https://appleid.apple.com/.well-known/openid-configuration',
});
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 65_536;
const CLOCK_SKEW_SECONDS = 120;

type ProviderClient = {
  provider: ProviderSecurityProvider;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
};
type Discovery = { authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; issuer: string };

/** The configured client for a provider, from NextAuth's provider list; undefined when it is not configured. */
export function providerClient(
  options: typeof authOptions,
  provider: ProviderSecurityProvider,
): ProviderClient | undefined {
  const configured = options.providers.find((candidate) => (candidate.options?.id ?? candidate.id) === provider);
  if (!configured || configured.type !== 'oauth') return undefined;
  const settings = (configured.options ?? {}) as { clientId?: unknown; clientSecret?: unknown; wellKnown?: unknown };
  const clientId = settings.clientId;
  const clientSecret = settings.clientSecret;
  const wellKnown = settings.wellKnown ?? configured.wellKnown ?? DEFAULT_DISCOVERY[provider];
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) return undefined;
  if (typeof wellKnown !== 'string') return undefined;
  return { provider, clientId, clientSecret, discoveryUrl: wellKnown };
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) throw new AuthBackendUnavailableError();
  return JSON.parse(text) as unknown;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: response.status, body: await boundedJson(response) };
}

function stringField(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const field = (body as Record<string, unknown>)[name];
  return typeof field === 'string' && field ? field : undefined;
}

const discoveries = new Map<string, { discovery: Discovery; fetchedAt: number }>();
const DISCOVERY_TTL_MS = 60 * 60_000;

async function discover(client: ProviderClient): Promise<Discovery> {
  const cached = discoveries.get(client.discoveryUrl);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.discovery;
  const { status, body } = await fetchJson(client.discoveryUrl);
  const issuer = stringField(body, 'issuer');
  const authorizationEndpoint = stringField(body, 'authorization_endpoint');
  const tokenEndpoint = stringField(body, 'token_endpoint');
  const jwksUri = stringField(body, 'jwks_uri');
  if (status !== 200 || !issuer || !ISSUERS[client.provider].includes(issuer)) throw new AuthBackendUnavailableError();
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) throw new AuthBackendUnavailableError();
  const discovery = { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
  discoveries.set(client.discoveryUrl, { discovery, fetchedAt: Date.now() });
  return discovery;
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The provider's authorization URL for one round trip. A Google
 * reauthentication forces a fresh sign-in (`max_age=0`,
 * `prompt=select_account consent`); a link lets the climber choose the
 * account to connect. Apple answers by `form_post`.
 */
export async function authorizationUrl(
  client: ProviderClient,
  roundTrip: ProviderFlowRoundTrip,
  redirectUri: string,
  purpose: 'link' | 'reauthenticate',
): Promise<string> {
  const { authorizationEndpoint } = await discover(client);
  const url = new URL(authorizationEndpoint);
  const parameters: Record<string, string> = {
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: roundTrip.state,
    nonce: roundTrip.nonce,
    code_challenge: pkceChallenge(roundTrip.verifier),
    code_challenge_method: 'S256',
    ...(client.provider === 'apple'
      ? { scope: 'name email', response_mode: 'form_post' }
      : { scope: 'openid email profile' }),
    ...(client.provider === 'google'
      ? purpose === 'reauthenticate'
        ? GOOGLE_FORCED_REAUTHENTICATION
        : { prompt: 'select_account' }
      : {}),
  };
  for (const [name, content] of Object.entries(parameters)) url.searchParams.set(name, content);
  return url.href;
}

/** What a verified ID token says about who signed in. */
export type VerifiedProviderIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  /** The raw token, for the backend's own Google check. Never logged. */
  idToken: string;
};

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuthBackendUnavailableError();
  return parsed as Record<string, unknown>;
}

const keySets = new Map<string, { keys: readonly Record<string, unknown>[]; fetchedAt: number }>();
const KEY_SET_TTL_MS = 60 * 60_000;

async function fetchKeySet(jwksUri: string): Promise<readonly Record<string, unknown>[]> {
  const { status, body } = await fetchJson(jwksUri);
  const keys = body && typeof body === 'object' ? (body as { keys?: unknown }).keys : undefined;
  if (status !== 200 || !Array.isArray(keys)) throw new AuthBackendUnavailableError();
  const usable = keys.filter(
    (candidate): candidate is Record<string, unknown> => !!candidate && typeof candidate === 'object',
  );
  keySets.set(jwksUri, { keys: usable, fetchedAt: Date.now() });
  return usable;
}

/**
 * The issuer's key for `kid`: from a key set cached for an hour (fetched with
 * the same 5-second timeout), fetched again once when the cached set has no
 * such key, as after a rotation.
 */
async function signingKey(jwksUri: string, keyId: string) {
  const cached = keySets.get(jwksUri);
  const fresh = cached && Date.now() - cached.fetchedAt < KEY_SET_TTL_MS ? cached.keys : undefined;
  const find = (keys: readonly Record<string, unknown>[]) => keys.filter((candidate) => candidate.kid === keyId);
  let matching = fresh ? find(fresh) : [];
  if (matching.length === 0) matching = find(await fetchKeySet(jwksUri));
  if (matching.length !== 1) throw new AuthBackendUnavailableError();
  const { kty, n: modulus, e: exponent } = matching[0];
  if (kty !== 'RSA' || typeof modulus !== 'string' || typeof exponent !== 'string')
    throw new AuthBackendUnavailableError();
  return createPublicKey({ key: { kty, n: modulus, e: exponent }, format: 'jwk' });
}

async function verifyIdToken(
  client: ProviderClient,
  discovery: Discovery,
  idToken: string,
  expectedNonce: string,
): Promise<VerifiedProviderIdentity> {
  const segments = idToken.split('.');
  if (segments.length !== 3 || idToken.length > 16_384) throw new AuthBackendUnavailableError();
  const header = decodeSegment(segments[0]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthBackendUnavailableError();
  const key = await signingKey(discovery.jwksUri, header.kid);
  const signed = Buffer.from(`${segments[0]}.${segments[1]}`, 'utf8');
  if (!verify('RSA-SHA256', signed, key, Buffer.from(segments[2], 'base64url')))
    throw new AuthBackendUnavailableError();
  const claims = decodeSegment(segments[1]);
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    typeof claims.iss !== 'string' ||
    !ISSUERS[client.provider].includes(claims.iss) ||
    !audience.includes(client.clientId) ||
    (audience.length > 1 && claims.azp !== client.clientId) ||
    (claims.azp !== undefined && claims.azp !== client.clientId) ||
    typeof claims.exp !== 'number' ||
    claims.exp + CLOCK_SKEW_SECONDS < now ||
    typeof claims.iat !== 'number' ||
    claims.iat - CLOCK_SKEW_SECONDS > now ||
    claims.nonce !== expectedNonce ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 1024
  )
    throw new AuthBackendUnavailableError();
  const email = typeof claims.email === 'string' && claims.email ? claims.email : null;
  // Apple sends `email_verified` as the string "true".
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  return { subject: claims.sub, email, emailVerified, idToken };
}

/**
 * Exchanges the callback's code (with this round trip's PKCE verifier) at the
 * provider's token endpoint and verifies the ID token it returns against this
 * round trip's nonce. Throws `AuthBackendUnavailableError` on anything else.
 */
export async function redeemAuthorizationCode(
  client: ProviderClient,
  roundTrip: ProviderFlowRoundTrip,
  redirectUri: string,
  code: string,
): Promise<VerifiedProviderIdentity> {
  try {
    const discovery = await discover(client);
    const { status, body } = await fetchJson(discovery.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: roundTrip.verifier,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }).toString(),
    });
    const idToken = stringField(body, 'id_token');
    if (status !== 200 || !idToken) throw new AuthBackendUnavailableError();
    return await verifyIdToken(client, discovery, idToken, roundTrip.nonce);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
