import { requiresWebSignOutForwarding, setPasswordMode } from '@boardsesh/auth-protocol';
import { parseCutoffEnforcement } from '../credential-cutoffs';
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

/** No environment bypass: historical issuer/old no-SID safety is not qualified. */
export function assertWebSessionWriterActivationConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  assertWebSessionWriterConfiguration(environment);
  if (requiresWebSignOutForwarding(environment))
    throw new Error(
      'Web SID denial activation blocked: historical issuer retirement and old no-SID safety proof required',
    );
}
