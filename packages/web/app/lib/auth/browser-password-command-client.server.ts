import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  BROWSER_PASSWORD_COMMAND_PATHS,
  BROWSER_PASSWORD_REQUEST_BYTES,
  BROWSER_PASSWORD_RESPONSE_BYTES,
  browserPasswordCommandSchema,
  browserPasswordMode,
  browserPasswordReplySchema,
  browserPasswordReplyStatus,
  type BrowserPasswordCommand,
  type BrowserPasswordReply,
} from '@boardsesh/auth-protocol/browser-password-v1';
import type { BrowserSourceCredential } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

type Operation = BrowserPasswordCommand['operation'];
type Payload<Selected extends Operation> = Extract<BrowserPasswordCommand, { operation: Selected }>['payload'];
export type BrowserPasswordOperationReply<Selected extends Operation> = BrowserPasswordReply & {
  readonly operation: Selected;
};
export type BrowserPasswordCommandClient = {
  readonly [Selected in Operation]: (payload: Payload<Selected>) => Promise<BrowserPasswordOperationReply<Selected>>;
};
export const browserPasswordTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
/** Exact actual-byte domain shared with the private browser-selection receipt. */
export function browserPasswordCandidateHash(candidate: BrowserSourceCredential): string {
  return browserPasswordTokenHash(
    JSON.stringify([
      'browser-selection-credential-v2',
      candidate.kind,
      candidate.kind === 'canonical-token' ? candidate.token : candidate.credential,
    ]),
  );
}

/** Service-only destinations. A public caller cannot select the target UID,
 * authority, credential kind, proof or completion from response metadata. */
export function createBrowserPasswordCommandClient(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): BrowserPasswordCommandClient {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  try {
    if (browserPasswordMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(BROWSER_PASSWORD_COMMAND_PATHS),
    requestBytes: BROWSER_PASSWORD_REQUEST_BYTES,
    responseBytes: BROWSER_PASSWORD_RESPONSE_BYTES,
  });
  async function command<Selected extends Operation>(
    operation: Selected,
    payload: Payload<Selected>,
  ): Promise<BrowserPasswordOperationReply<Selected>> {
    try {
      const submitted = browserPasswordCommandSchema.parse({
        browserPasswordProtocolVersion: 1,
        requestId: randomUUID(),
        issuedAt: Date.now(),
        operation,
        payload,
      });
      if (submitted.operation !== 'prepare') {
        const source = submitted.payload.source;
        const preparation = submitted.payload.preparation;
        if (
          browserPasswordTokenHash(source.bindingToken) !== preparation.browserCursor.bindingId ||
          (source.state === 'selected' &&
            preparation.source.state === 'selected' &&
            browserPasswordCandidateHash(source.actor.credential) !== preparation.source.credentialHash)
        )
          throw new AuthBackendUnavailableError();
      }
      const response = await transport.post(BROWSER_PASSWORD_COMMAND_PATHS[submitted.operation], submitted);
      const reply = browserPasswordReplySchema.parse(response.body);
      if (
        reply.operation !== submitted.operation ||
        reply.requestId !== submitted.requestId ||
        browserPasswordReplyStatus(reply) !== response.status
      )
        throw new AuthBackendUnavailableError();
      if (reply.outcome === 'prepared') {
        if (submitted.operation !== 'prepare') throw new AuthBackendUnavailableError();
        const expected = submitted.payload;
        const prepared = reply.preparation;
        if (
          prepared.browserCursor.bindingId !== browserPasswordTokenHash(expected.source.bindingToken) ||
          prepared.browserCursor.version !== expected.source.expectedVersion ||
          prepared.source.state !== expected.source.state ||
          prepared.nonceHash !== expected.nonceHash ||
          prepared.credentialKind !== expected.credentialKind ||
          (expected.source.state === 'selected' &&
            prepared.source.state === 'selected' &&
            prepared.source.credentialHash !== browserPasswordCandidateHash(expected.source.actor.credential)) ||
          (reply.proposedCanonicalToken !== null &&
            prepared.proposedCanonicalTokenHash !==
              browserPasswordCandidateHash({ kind: 'canonical-token', token: reply.proposedCanonicalToken }))
        )
          throw new AuthBackendUnavailableError();
      }
      if (reply.outcome === 'completed') {
        if (submitted.operation !== 'finalize' && submitted.operation !== 'acknowledge')
          throw new AuthBackendUnavailableError();
        const expected = submitted.payload.preparation;
        if (
          reply.cursor.bindingId !== expected.futureBrowserCursor.bindingId ||
          reply.cursor.version !== expected.futureBrowserCursor.version ||
          reply.cursor.bindingExpiresAt !== expected.futureBrowserCursor.bindingExpiresAt ||
          reply.candidateCredentialHash !== browserPasswordCandidateHash(submitted.payload.candidate) ||
          JSON.stringify(reply.credentialProof) !== JSON.stringify(expected.credentialProof) ||
          reply.credentialExpiresAt !== expected.credentialExpiresAt
        )
          throw new AuthBackendUnavailableError();
      }
      return reply as BrowserPasswordOperationReply<Selected>;
    } catch {
      throw new AuthBackendUnavailableError();
    }
  }
  return {
    prepare: (payload) => command('prepare', payload),
    finalize: (payload) => command('finalize', payload),
    acknowledge: (payload) => command('acknowledge', payload),
    abort: (payload) => command('abort', payload),
  };
}
