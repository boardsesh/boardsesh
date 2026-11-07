import { CURRENT_EMAIL_NORMALIZER_VERSION } from './foundation-context';
import type { WebPasswordAuthority } from './command-context';

type Environment = Readonly<Record<string, string | undefined>>;

/** Invoked only after the caller explicitly selects its own staging mode. */
export function currentStoreAuthorityConfiguration(environment: Environment): WebPasswordAuthority {
  if (environment.DEBUG_SQL === 'true') throw new Error('Unsafe current-store auth SQL logging');
  const projectionId = environment.CURRENT_STORE_AUTH_PROJECTION_ID;
  const epochText = environment.CURRENT_STORE_AUTH_WRITER_EPOCH;
  if (
    !projectionId ||
    projectionId !== projectionId.trim() ||
    projectionId.length > 256 ||
    !epochText ||
    !/^[1-9]\d*$/.test(epochText) ||
    !Number.isSafeInteger(Number(epochText)) ||
    Number(epochText) > 2_147_483_647
  )
    throw new Error('Invalid current-store authority configuration');
  return {
    expectedProjectionId: projectionId,
    expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    expectedWriterEpoch: Number(epochText),
    emailVerificationEnabled: environment.EMAIL_VERIFICATION_ENABLED === 'true',
  };
}

export function currentStoreNativeRegistrationConfiguration(
  environment: Environment = process.env,
): { readonly mode: 'legacy' } | { readonly mode: 'reserved-staging'; readonly authority: WebPasswordAuthority } {
  const mode = environment.CURRENT_STORE_NATIVE_REGISTRATION_MODE;
  if (mode === undefined || mode === '' || mode === 'legacy') return { mode: 'legacy' };
  if (mode !== 'reserved-staging') throw new Error('Invalid native registration mode');
  return { mode, authority: currentStoreAuthorityConfiguration(environment) };
}

export function currentStoreNativeOAuthConfiguration(
  environment: Environment = process.env,
): { readonly mode: 'legacy' } | { readonly mode: 'reserved-staging'; readonly authority: WebPasswordAuthority } {
  const mode = environment.CURRENT_STORE_NATIVE_OAUTH_MODE;
  if (mode === undefined || mode === '' || mode === 'legacy') return { mode: 'legacy' };
  if (mode !== 'reserved-staging') throw new Error('Invalid native OAuth mode');
  return { mode, authority: currentStoreAuthorityConfiguration(environment) };
}
