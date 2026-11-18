import { requiresWebSignOutForwarding, setPasswordMode } from '@boardsesh/auth-protocol';
import { parseCutoffEnforcement } from '../credential-cutoffs';
import { AUTHORITY_ACTIVATION_BLOCKERS, HISTORICAL_WEB_ISSUER_RETIREMENT } from '../authority/activation-gates';
import { currentStoreRpcSecret } from './authority-configuration';

/** Before listeners/jobs. SID denials remain independent of bridge rollback. */
export function assertWebSessionWriterConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const forwardSignOut = requiresWebSignOutForwarding(environment);
  const passwordMode = setPasswordMode(environment);
  if ((forwardSignOut || passwordMode === 'backend-staging') && environment.DEBUG_SQL === 'true')
    throw new Error('Unsafe web credential SQL logging');
  if (forwardSignOut) {
    if (parseCutoffEnforcement(environment.AUTH_CUTOFF_ENFORCEMENT) !== 'enforce')
      throw new Error('Web SID denial writer requires cutoff enforcement');
    currentStoreRpcSecret(environment);
  }
}

/**
 * No environment bypass. The web SID denial writer waits on the activation
 * entry HISTORICAL_WEB_ISSUER_RETIREMENT: the owner's confirmation that the old
 * web sign-in issuers are retired. Old no-SID safety is closed in code (#7596
 * B2c). The refusal lifts when a reviewed PR removes that entry; `blockers` is
 * a parameter for tests only.
 */
export function assertWebSessionWriterActivationConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  blockers: readonly string[] = AUTHORITY_ACTIVATION_BLOCKERS,
): void {
  assertWebSessionWriterConfiguration(environment);
  if (requiresWebSignOutForwarding(environment) && blockers.includes(HISTORICAL_WEB_ISSUER_RETIREMENT))
    throw new Error(
      `Web SID denial activation blocked: ${HISTORICAL_WEB_ISSUER_RETIREMENT}, the owner confirming historical issuer retirement`,
    );
}
