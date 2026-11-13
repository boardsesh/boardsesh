import { firstPasswordMode } from '@boardsesh/auth-protocol';
import { currentStoreAuthorityConfiguration, currentStoreRpcSecret } from '../current-store/authority-configuration';
import { captureFirstPasswordRuntime } from './first-password-policy';

/** Default off; configuration is a source selector, never a rollout attestation. */
export function firstPasswordConfiguration(input: Readonly<Record<string, string | undefined>> = process.env) {
  const environment = Object.freeze({ ...input });
  const mode = firstPasswordMode(environment);
  if (mode === 'legacy') return { mode } as const;
  const authority = currentStoreAuthorityConfiguration(environment);
  const rpcSecret = currentStoreRpcSecret(environment);
  return {
    mode,
    rpcSecret,
    runtime: captureFirstPasswordRuntime({
      qualification: {
        expectedProjectionId: authority.expectedProjectionId,
        expectedNormalizerVersion: authority.expectedNormalizerVersion,
      },
      legacySecret: environment.NEXTAUTH_SECRET,
      emailBindingKey: rpcSecret,
    }),
  } as const;
}
