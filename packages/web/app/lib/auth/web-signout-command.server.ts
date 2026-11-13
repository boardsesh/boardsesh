import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  requiresWebSignOutForwarding,
  webSignOutReplySchema,
} from '@boardsesh/auth-protocol';
import { createAuthCommandTransport, AuthBackendUnavailableError } from './auth-command-transport.server';

/** A confirmed denial precedes cookie clearing; RPC failures never fall back. */
export async function forwardWebSignOut(credential: string): Promise<void> {
  try {
    if (!requiresWebSignOutForwarding(process.env)) return;
    const requestId = randomUUID();
    const transport = createAuthCommandTransport({ environment: process.env, paths: [AUTH_COMMAND_PATHS.signout] });
    const response = await transport.post(AUTH_COMMAND_PATHS.signout, {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'signout',
      requestId,
      issuedAt: Date.now(),
      payload: { credential },
    });
    const reply = webSignOutReplySchema.parse(response.body);
    if (response.status !== 200 || reply.requestId !== requestId || reply.outcome !== 'signed_out')
      throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

/** Public NextAuth emits empty values only after successful sign-out CSRF handling. */
export function responseClearsNextAuthSession(response: Response): boolean {
  return /(?:^|,\s*)(?:__Secure-)?next-auth\.session-token(?:\.\d+)?=;/.test(response.headers.get('set-cookie') ?? '');
}
