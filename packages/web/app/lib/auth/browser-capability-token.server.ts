import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  BROWSER_DELEGATION_COMMAND_PATH,
  BROWSER_DELEGATION_PROTOCOL_VERSION,
  BROWSER_DELEGATION_REQUEST_BYTES,
  BROWSER_DELEGATION_RESPONSE_BYTES,
  browserDelegationCommandSchema,
  browserDelegationReplySchema,
} from '@boardsesh/auth-protocol/browser-delegation-v1';
import {
  NATIVE_BROWSER_HANDOFF_COMMAND_PATH,
  NATIVE_BROWSER_HANDOFF_PROTOCOL_VERSION,
  NATIVE_BROWSER_HANDOFF_REQUEST_BYTES,
  NATIVE_BROWSER_HANDOFF_RESPONSE_BYTES,
  nativeBrowserHandoffCommandSchema,
  nativeBrowserHandoffReplySchema,
  type NativeProviderSigninContext,
} from '@boardsesh/auth-protocol/native-browser-handoff-v1';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import { createAuthCommandTransport, type AuthServiceEnvironment } from './auth-command-transport.server';
import type { AdmittedBrowserSelection } from './presented-browser-selection.server';

export type BrowserCapabilityTokenResult =
  | {
      readonly status: 'admitted';
      readonly token: string;
      readonly expiresAt: string;
      /** Conservative duration for a receiving client's monotonic cache. */
      readonly usableForMs: number;
      readonly cursor: AdmittedBrowserSelection['cursor'];
      readonly userId: string;
      readonly authSessionId: string;
    }
  | { readonly status: 'denied' | 'conflict' | 'unavailable' };

/** A request-local short lease. The backend re-admits actual source proof;
 * no signer or backend-only key exists in the web runtime. */
export interface BrowserCapabilityTokenOptions {
  readonly environment?: AuthServiceEnvironment;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Native handoff only; the backend verifies the durable provider proof. */
  readonly providerSignin?: NativeProviderSigninContext;
}
export async function issueBrowserCapabilityToken(
  selection: AdmittedBrowserSelection,
  purpose: 'backend-delegation' | 'native-handoff',
  options: BrowserCapabilityTokenOptions = {},
): Promise<BrowserCapabilityTokenResult> {
  try {
    if (purpose !== 'native-handoff' && options.providerSignin) return { status: 'unavailable' };
    const startedAt = performance.now();
    const environment = Object.freeze({ ...(options.environment ?? process.env) });
    if (browserBindingMode(environment) !== 'backend-staging') return { status: 'unavailable' };
    const wire =
      purpose === 'backend-delegation'
        ? {
            path: BROWSER_DELEGATION_COMMAND_PATH,
            requestBytes: BROWSER_DELEGATION_REQUEST_BYTES,
            responseBytes: BROWSER_DELEGATION_RESPONSE_BYTES,
            commandSchema: browserDelegationCommandSchema,
            replySchema: browserDelegationReplySchema,
            metadata: {
              browserDelegationProtocolVersion: BROWSER_DELEGATION_PROTOCOL_VERSION,
              operation: 'delegate' as const,
            },
          }
        : {
            path: NATIVE_BROWSER_HANDOFF_COMMAND_PATH,
            requestBytes: NATIVE_BROWSER_HANDOFF_REQUEST_BYTES,
            responseBytes: NATIVE_BROWSER_HANDOFF_RESPONSE_BYTES,
            commandSchema: nativeBrowserHandoffCommandSchema,
            replySchema: nativeBrowserHandoffReplySchema,
            metadata: {
              nativeBrowserHandoffProtocolVersion: NATIVE_BROWSER_HANDOFF_PROTOCOL_VERSION,
              operation: 'issue' as const,
            },
          };
    const command = wire.commandSchema.parse({
      ...wire.metadata,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: {
        bindingToken: selection.bindingToken,
        actor: selection.actor,
        ...(purpose === 'native-handoff' && options.providerSignin ? { providerSignin: options.providerSignin } : {}),
      },
    });
    // Capture local correlation before the first await as well as source bytes.
    const expected = {
      bindingId: selection.cursor.bindingId,
      version: selection.cursor.version,
      bindingExpiresAt: selection.cursor.bindingExpiresAt,
      userId: selection.session.userId,
      authSessionId: selection.session.authSessionId,
      sourceExpiresAt: selection.session.expiresAt,
    };
    const transport = createAuthCommandTransport({
      ...options,
      environment,
      paths: [wire.path],
      requestBytes: wire.requestBytes,
      responseBytes: wire.responseBytes,
    });
    const response = await transport.post(wire.path, command);
    const reply = wire.replySchema.parse(response.body);
    if (
      reply.requestId !== command.requestId ||
      { admitted: 200, denied: 401, conflict: 409, unavailable: 503 }[reply.outcome] !== response.status
    )
      return { status: 'unavailable' };
    if (reply.outcome !== 'admitted') return { status: reply.outcome };
    const deadline = Date.parse(reply.expiresAt);
    const duration = deadline - Date.parse(reply.issuedAt);
    const sourceDeadline = Date.parse(expected.sourceExpiresAt);
    const bindingDeadline = Date.parse(expected.bindingExpiresAt);
    if (
      reply.cursor.bindingId !== expected.bindingId ||
      reply.cursor.version !== expected.version ||
      reply.cursor.bindingExpiresAt !== expected.bindingExpiresAt ||
      reply.userId !== expected.userId ||
      reply.authSessionId !== expected.authSessionId ||
      !Number.isFinite(sourceDeadline) ||
      !Number.isFinite(bindingDeadline) ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 120_000 ||
      deadline > Math.min(sourceDeadline, bindingDeadline)
    )
      return { status: 'unavailable' };
    // Debit the whole roundtrip, including time before backend issuance. This
    // is conservative without comparing two hosts' clocks for the lease span.
    const localDeadline = Math.min(
      deadline,
      sourceDeadline,
      bindingDeadline,
      Date.now() + duration - (performance.now() - startedAt),
    );
    if (localDeadline <= Date.now()) return { status: 'unavailable' };
    return Object.freeze({
      status: 'admitted',
      token: reply.token,
      expiresAt: new Date(localDeadline).toISOString(),
      usableForMs: Math.max(0, Math.floor(localDeadline - Date.now())),
      cursor: Object.freeze({ ...reply.cursor }),
      userId: reply.userId,
      authSessionId: reply.authSessionId,
    });
  } catch {
    return { status: 'unavailable' };
  }
}
