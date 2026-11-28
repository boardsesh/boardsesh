import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  NATIVE_TRANSFER_COMMAND_PATH,
  NATIVE_TRANSFER_PROTOCOL_VERSION,
  NATIVE_TRANSFER_REQUEST_BYTES,
  nativeTransferCommandSchema,
  nativeTransferReplySchema,
  nativeTransferReplyStatus,
  type NativeTransferReply,
} from '@boardsesh/auth-protocol/native-oauth-transfer';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

/** One request, no retry: losing a committed reply cannot make its transfer usable twice. */
export function createNativeTransferCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
) {
  const transport = createAuthCommandTransport({
    ...options,
    paths: [NATIVE_TRANSFER_COMMAND_PATH],
    requestBytes: NATIVE_TRANSFER_REQUEST_BYTES,
  });
  return {
    async claim(transferToken: string): Promise<Exclude<NativeTransferReply, { outcome: 'unavailable' }>> {
      try {
        const command = nativeTransferCommandSchema.parse({
          nativeTransferProtocolVersion: NATIVE_TRANSFER_PROTOCOL_VERSION,
          operation: 'claim',
          requestId: randomUUID(),
          issuedAt: Date.now(),
          payload: { transferToken },
        });
        const response = await transport.post(NATIVE_TRANSFER_COMMAND_PATH, command);
        const reply = nativeTransferReplySchema.parse(response.body);
        if (
          reply.requestId !== command.requestId ||
          nativeTransferReplyStatus(reply) !== response.status ||
          reply.outcome === 'unavailable'
        )
          throw new AuthBackendUnavailableError();
        return reply;
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  };
}
