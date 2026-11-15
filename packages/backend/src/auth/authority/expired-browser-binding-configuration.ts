import { expiredBrowserBindingMode } from '@boardsesh/auth-protocol/expired-browser-binding-v1';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import { currentStoreAuthorityConfiguration, currentStoreRpcSecret } from '../current-store/authority-configuration';

export function expiredBrowserBindingConfiguration(input: Readonly<Record<string, string | undefined>> = process.env) {
  const environment = Object.freeze({ ...input });
  const mode = expiredBrowserBindingMode(environment);
  if (mode === 'legacy') return { mode } as const;
  if (browserBindingMode(environment) !== 'backend-staging')
    throw new Error('EXPIRED_BROWSER_BINDING_COORDINATOR_REQUIRED');
  const authority = currentStoreAuthorityConfiguration(environment);
  return {
    mode,
    requiredContract: 'private-provider-v1' as const,
    rpcSecret: currentStoreRpcSecret(environment),
    qualification: Object.freeze({
      expectedProjectionId: authority.expectedProjectionId,
      expectedNormalizerVersion: authority.expectedNormalizerVersion,
    }),
  } as const;
}
