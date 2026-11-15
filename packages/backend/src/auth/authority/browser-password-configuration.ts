import { browserPasswordMode } from '@boardsesh/auth-protocol/browser-password-v1';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import { currentStoreAuthorityConfiguration, currentStoreRpcSecret } from '../current-store/authority-configuration';

/** Private staging configuration alone never enables public credential publication. */
export function browserPasswordConfiguration(input: Readonly<Record<string, string | undefined>> = process.env) {
  const environment = Object.freeze({ ...input });
  const mode = browserPasswordMode(environment);
  if (mode === 'legacy') return { mode } as const;
  if (browserBindingMode(environment) !== 'backend-staging') throw new Error('BROWSER_PASSWORD_BINDING_REQUIRED');
  return {
    mode,
    requiredContract: 'private-provider-v1' as const,
    rpcSecret: currentStoreRpcSecret(environment),
    runtime: Object.freeze({
      authority: Object.freeze(currentStoreAuthorityConfiguration(environment)),
      legacySecret: environment.NEXTAUTH_SECRET,
    }),
  } as const;
}
