import { providerSecurityMode } from '@boardsesh/auth-protocol';
import { currentStoreAuthorityConfiguration, currentStoreRpcSecret } from '../current-store/authority-configuration';
import {
  captureProviderSecurityMethodsConfiguration,
  type ProviderSecurityEnvironment,
} from './provider-security-policy';

/** Source selection is dark by default and never attests transport/role/browser readiness. */
export function providerSecurityConfiguration(input: ProviderSecurityEnvironment = process.env) {
  const environment = Object.freeze({ ...input });
  const mode = providerSecurityMode(environment);
  if (mode === 'legacy') return { mode } as const;
  const authority = currentStoreAuthorityConfiguration(environment);
  const rpcSecret = currentStoreRpcSecret(environment);
  const legacySecret = environment.NEXTAUTH_SECRET;
  if (!legacySecret) throw new Error('Provider credential reader key unavailable');
  return {
    mode,
    rpcSecret,
    runtime: Object.freeze({
      qualification: Object.freeze({
        expectedProjectionId: authority.expectedProjectionId,
        expectedNormalizerVersion: authority.expectedNormalizerVersion,
      }),
      legacySecret,
      methods: captureProviderSecurityMethodsConfiguration(environment),
    }),
  } as const;
}
