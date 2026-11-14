import { browserRenewalMode } from '@boardsesh/auth-protocol/browser-renewal-v1';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import { currentStoreAuthorityConfiguration, currentStoreRpcSecret } from '../current-store/authority-configuration';

/** Service configuration never proves public activation. Defaults stay off. */
export function browserRenewalConfiguration(input: Readonly<Record<string, string | undefined>> = process.env) {
  const environment = Object.freeze({ ...input });
  const mode = browserRenewalMode(environment);
  if (mode === 'legacy') return { mode } as const;
  if (browserBindingMode(environment) !== 'backend-staging') throw new Error('BROWSER_RENEWAL_BINDING_REQUIRED');
  const authority = currentStoreAuthorityConfiguration(environment);
  return {
    mode,
    rpcSecret: currentStoreRpcSecret(environment),
    runtime: Object.freeze({
      qualification: Object.freeze({
        expectedProjectionId: authority.expectedProjectionId,
        expectedNormalizerVersion: authority.expectedNormalizerVersion,
      }),
      legacySecret: environment.NEXTAUTH_SECRET,
    }),
  } as const;
}
