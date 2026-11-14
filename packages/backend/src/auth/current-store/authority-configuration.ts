import { assertMirroredNativeWriterMode } from '../authority/mirror-configuration';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from './foundation-context';
import type { WebPasswordAuthority } from './command-context';
import {
  AUTH_COMMAND_ENV,
  LOCATION_SYNC_COMMAND_ENV,
  currentStoreLocationSyncMode,
  BATCH_SYSTEM_USER_COMMAND_ENV,
  currentStoreBatchSystemUsersMode as parseBatchSystemUsersMode,
} from '@boardsesh/auth-protocol';
import { logger } from '../../utils/logger';
import { AUTH_CUTOFF_ENFORCEMENT_ENV, parseCutoffEnforcement } from '../credential-cutoffs';

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

export const DELETED_EMAIL_KEY_ENV = 'CURRENT_STORE_DELETED_EMAIL_KEY';

/**
 * The HMAC key behind a deleted account's address digest. Rotating it frees
 * every address deleted in the last 90 days early, so it stays put once set.
 * Every staged mode needs it: an unknown address looks up its digest, so a
 * missing key would fail only for unknown addresses and reveal which exist.
 */
export function currentStoreDeletedEmailKey(environment: Environment = process.env): string {
  const key = environment[DELETED_EMAIL_KEY_ENV];
  if (
    !key ||
    key !== key.trim() ||
    Buffer.byteLength(key, 'utf8') < 32 ||
    [
      environment.NEXTAUTH_SECRET,
      environment.CRON_SECRET,
      environment.CURRENT_STORE_AUTH_RPC_SECRET,
      environment[BATCH_SYSTEM_USER_COMMAND_ENV.secret],
    ].some((otherSecret) => Boolean(otherSecret) && otherSecret === key)
  ) {
    // Names the variable, never its value.
    logger.error(`Current-store auth unavailable: ${DELETED_EMAIL_KEY_ENV} is missing, too short or reused`);
    throw new Error('Invalid current-store deleted-email configuration');
  }
  return key;
}

/** Every switch that turns on a staged writer of credentials or cutoffs. Unset, empty or `legacy` is off. */
export const STAGED_WRITER_MODE_ENV = [
  'CURRENT_STORE_BROWSER_BINDING_MODE',
  'CURRENT_STORE_BROWSER_RENEWAL_MODE',
  AUTH_COMMAND_ENV.mode,
  'CURRENT_STORE_WEB_OAUTH_MODE',
  'CURRENT_STORE_NATIVE_REGISTRATION_MODE',
  'CURRENT_STORE_NATIVE_OAUTH_MODE',
  'CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE',
  'CURRENT_STORE_ACCOUNT_DELETION_MODE',
  'CURRENT_STORE_SET_PASSWORD_MODE',
  'CURRENT_STORE_PROVIDER_SECURITY_MODE',
  'CURRENT_STORE_FIRST_PASSWORD_MODE',
  'CURRENT_STORE_WEB_SIGNOUT_MODE',
  'AUTH_WATCH_PAIRING_MODE',
  BATCH_SYSTEM_USER_COMMAND_ENV.mode,
  LOCATION_SYNC_COMMAND_ENV.mode,
] as const;

/**
 * Checked once at startup. A staged writer bumps generations, and under
 * `observe` no reader would enforce them, so a reset would end nothing. The
 * backend refuses to start with both, and with an unknown enforcement value.
 */
export function assertCutoffEnforcementConfiguration(environment: Environment = process.env): void {
  const enforcement = parseCutoffEnforcement(environment[AUTH_CUTOFF_ENFORCEMENT_ENV]);
  if (enforcement === 'enforce') return;
  const selected = STAGED_WRITER_MODE_ENV.filter((name) => ![undefined, '', 'legacy'].includes(environment[name]));
  if (selected.length > 0)
    throw new Error(`${AUTH_CUTOFF_ENFORCEMENT_ENV}=observe cannot run with ${selected.join(', ')} on`);
}

/** Invoked only after the caller explicitly selects its own staging mode. */
export function currentStoreAuthorityConfiguration(environment: Environment): WebPasswordAuthority {
  if (environment.DEBUG_SQL === 'true') throw new Error('Unsafe current-store auth SQL logging');
  // The startup check stops this too; repeated per command for an environment changed since.
  if (parseCutoffEnforcement(environment[AUTH_CUTOFF_ENFORCEMENT_ENV]) !== 'enforce')
    throw new Error('Staged auth writers need cutoff enforcement');
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
  // Fails every staged mode alike at configuration, never per address.
  currentStoreDeletedEmailKey(environment);
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
  assertMirroredNativeWriterMode(mode === 'reserved-staging' ? mode : 'legacy', environment);
  if (mode === undefined || mode === '' || mode === 'legacy') return { mode: 'legacy' };
  if (mode !== 'reserved-staging') throw new Error('Invalid native registration mode');
  return { mode, authority: currentStoreAuthorityConfiguration(environment) };
}

export function currentStoreNativeOAuthConfiguration(
  environment: Environment = process.env,
): { readonly mode: 'legacy' } | { readonly mode: 'reserved-staging'; readonly authority: WebPasswordAuthority } {
  const mode = environment.CURRENT_STORE_NATIVE_OAUTH_MODE;
  assertMirroredNativeWriterMode(mode === 'reserved-staging' ? mode : 'legacy', environment);
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
  // Includes the digest key, so a missing key fails before content runs.
  return { mode, authority: currentStoreAuthorityConfiguration(environment) };
}

export function currentStoreLocationSyncConfiguration(environment: Environment = process.env) {
  const mode = currentStoreLocationSyncMode(environment);
  if (mode === 'legacy') return { mode } as const;
  if (environment.CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE !== 'cooperative-staging')
    throw new Error('Compound location sync requires cooperative fixed-owner ordering');
  const rpcSecret = environment[LOCATION_SYNC_COMMAND_ENV.secret];
  if (
    !rpcSecret ||
    rpcSecret !== rpcSecret.trim() ||
    Buffer.byteLength(rpcSecret, 'utf8') < 32 ||
    [
      'NEXTAUTH_SECRET',
      'CRON_SECRET',
      'CURRENT_STORE_AUTH_RPC_SECRET',
      BATCH_SYSTEM_USER_COMMAND_ENV.secret,
      DELETED_EMAIL_KEY_ENV,
    ].some((key) => Boolean(environment[key]) && rpcSecret === environment[key])
  )
    throw new Error('Invalid location-sync authority configuration');
  return { mode, rpcSecret, authority: currentStoreAuthorityConfiguration(environment) } as const;
}
