import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from './foundation-context';
import type { WebPasswordAuthority } from './command-context';
import {
  BATCH_SYSTEM_USER_COMMAND_ENV,
  currentStoreBatchSystemUsersMode as parseBatchSystemUsersMode,
} from '@boardsesh/auth-protocol';

type Environment = Readonly<Record<string, string | undefined>>;

export function currentStoreBatchSystemUsersMode(environment: Environment = process.env) {
  return parseBatchSystemUsersMode(environment);
}

export function currentStoreBatchSystemUsersRpcSecret(environment: Environment): string {
  const secret = environment[BATCH_SYSTEM_USER_COMMAND_ENV.secret];
  if (
    !secret ||
    secret !== secret.trim() ||
    Buffer.byteLength(secret, 'utf8') < 32 ||
    [environment.NEXTAUTH_SECRET, environment.CRON_SECRET, environment.CURRENT_STORE_AUTH_RPC_SECRET].some(
      (otherSecret) => Boolean(otherSecret) && secret === otherSecret,
    )
  )
    throw new Error('Invalid batch system-user authority configuration');
  return secret;
}

export function currentStoreBatchSystemUsersConfiguration(environment: Environment = process.env) {
  const mode = currentStoreBatchSystemUsersMode(environment);
  if (mode === 'legacy') return { mode } as const;
  return {
    mode,
    authority: currentStoreAuthorityConfiguration(environment),
    rpcSecret: currentStoreBatchSystemUsersRpcSecret(environment),
  } as const;
}

export function currentStoreRpcSecret(environment: Environment): string {
  const rpcSecret = environment.CURRENT_STORE_AUTH_RPC_SECRET;
  if (
    !rpcSecret ||
    rpcSecret !== rpcSecret.trim() ||
    Buffer.byteLength(rpcSecret, 'utf8') < 32 ||
    [environment.NEXTAUTH_SECRET, environment.CRON_SECRET].some(
      (secret) => Boolean(secret?.trim()) && secret === rpcSecret,
    )
  )
    throw new Error('Invalid current-store web auth configuration');
  return rpcSecret;
}

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

export function currentStoreSystemBoardOwnerConfiguration(
  environment: Environment = process.env,
):
  | { readonly mode: 'legacy' }
  | { readonly mode: 'reserved-staging'; readonly authority: ExpectedCurrentStoreAuthority } {
  const mode = environment.CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE;
  if (mode === undefined || mode === '' || mode === 'legacy') return { mode: 'legacy' };
  if (mode !== 'reserved-staging') throw new Error('Invalid system board owner mode');
  return { mode, authority: currentStoreAuthorityConfiguration(environment) };
}

export function currentStoreAccountDeletionConfiguration(
  environment: Environment = process.env,
):
  | { readonly mode: 'legacy' }
  | { readonly mode: 'reserved-staging'; readonly authority: ExpectedCurrentStoreAuthority } {
  const mode = environment.CURRENT_STORE_ACCOUNT_DELETION_MODE;
  if (mode === undefined || mode === '' || mode === 'legacy') return { mode: 'legacy' };
  if (mode !== 'reserved-staging') throw new Error('Invalid account deletion mode');
  return { mode, authority: currentStoreAuthorityConfiguration(environment) };
}
