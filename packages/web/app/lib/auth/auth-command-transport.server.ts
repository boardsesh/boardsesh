import 'server-only';
import { AUTH_COMMAND_ENV } from '@boardsesh/auth-protocol';
import { createPrivateAuthCommandTransport, type AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';

export { AuthBackendUnavailableError, trustedAuthOrigin } from '@boardsesh/auth-protocol/transport';
export type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';

/** Server-only adapter preserves the released web transport configuration and defaults. */
export function createAuthCommandTransport(options: {
  paths: readonly string[];
  environment?: AuthServiceEnvironment;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  return createPrivateAuthCommandTransport({
    ...options,
    environment: options.environment ?? process.env,
    fetch: options.fetch ?? fetch,
    originKey: AUTH_COMMAND_ENV.origin,
    secretKey: AUTH_COMMAND_ENV.secret,
    disallowedSecretKeys: ['NEXTAUTH_SECRET', 'CRON_SECRET'],
  });
}
