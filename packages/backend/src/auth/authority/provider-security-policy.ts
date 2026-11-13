import { createHash } from 'node:crypto';
import type { ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import type { IdentityPasswordSnapshot, ProviderIdentitySnapshot } from './identity-authority';

export const PROVIDER_SECURITY_INTENT_LIFETIME_MS = 15 * 60_000;
export const PROVIDER_REAUTHENTICATION_LIFETIME_MS = 5 * 60_000;
export const PROVIDER_RESULT_RECOVERY_LIFETIME_MS = 2 * 60_000;
export type ProviderSecurityEnvironment = Readonly<Record<string, string | undefined>>;
export interface ProviderSecurityMethodsConfiguration {
  readonly configuredProviders: readonly ProviderSecurityProvider[];
  readonly googleAudience: string | null;
  readonly googleReauthenticationEnabled: boolean;
}

function identifier(candidate: string | undefined): candidate is string {
  return typeof candidate === 'string' && candidate.length > 0 && candidate === candidate.trim();
}

/** Only fixed, complete configurations count as a remaining sign-in method. */
export function captureProviderSecurityMethodsConfiguration(
  environment: ProviderSecurityEnvironment,
): ProviderSecurityMethodsConfiguration {
  const google = identifier(environment.GOOGLE_CLIENT_ID) && identifier(environment.GOOGLE_CLIENT_SECRET);
  const apple = identifier(environment.APPLE_ID) && identifier(environment.APPLE_SECRET);
  const googleFreshness = environment.CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE;
  if (![undefined, '', 'off', 'auth-time-staging'].includes(googleFreshness))
    throw new Error('PROVIDER_GOOGLE_FRESHNESS_CONFIGURATION_INVALID');
  return Object.freeze({
    configuredProviders: Object.freeze([
      ...(google ? (['google'] as const) : []),
      ...(apple ? (['apple'] as const) : []),
    ]),
    googleAudience: google ? environment.GOOGLE_CLIENT_ID! : null,
    googleReauthenticationEnabled: google && googleFreshness === 'auth-time-staging',
  });
}

/** No password comparison or rehash occurs when assessing an alternative method. */
export function isUsableProviderPassword(
  password: IdentityPasswordSnapshot | null,
  userId: string,
  generation: number,
): boolean {
  if (!password || password.userId !== userId || password.generation !== generation) return false;
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(password.passwordHash)) return false;
  const cost = Number(password.passwordHash.slice(4, 6));
  return cost >= 4 && cost <= 31;
}

export function isUsableProviderIdentity(
  identity: ProviderIdentitySnapshot,
  userId: string,
  generation: number,
  configuration: ProviderSecurityMethodsConfiguration,
): identity is ProviderIdentitySnapshot & { readonly provider: ProviderSecurityProvider } {
  return (
    identity.userId === userId &&
    identity.generation === generation &&
    Boolean(identity.subject) &&
    (identity.provider === 'google' || identity.provider === 'apple') &&
    configuration.configuredProviders.includes(identity.provider)
  );
}

export function providerMethodId(identity: ProviderIdentitySnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify(['provider-method-v1', identity.userId, identity.generation, identity.provider, identity.subject]),
    )
    .digest('hex');
}

/** Google auth_time is a signed authentication event, not token iat or callback time. */
export function googleReauthenticationDeadline(
  authTime: unknown,
  tokenExpiresAt: unknown,
  now: Date,
  intentExpiresAt: Date,
): Date | null {
  if (
    typeof authTime !== 'number' ||
    !Number.isSafeInteger(authTime) ||
    authTime <= 0 ||
    typeof tokenExpiresAt !== 'number' ||
    !Number.isSafeInteger(tokenExpiresAt) ||
    tokenExpiresAt <= 0
  )
    return null;
  const authenticatedAt = authTime * 1000;
  const expiry = Math.min(
    authenticatedAt + PROVIDER_REAUTHENTICATION_LIFETIME_MS,
    tokenExpiresAt * 1000,
    intentExpiresAt.getTime(),
  );
  return Number.isSafeInteger(authenticatedAt) && authenticatedAt <= now.getTime() && expiry > now.getTime()
    ? new Date(expiry)
    : null;
}
