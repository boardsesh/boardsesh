import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import { AUTH_COMMAND_ENV, parseWebAuthMode } from '@boardsesh/auth-protocol';
import { parseBrowserSessionMode } from '@boardsesh/auth-protocol/browser-session-mode';
import {
  NATIVE_TRANSFER_COMMAND_PATH,
  NATIVE_TRANSFER_PROTOCOL_VERSION,
  NATIVE_TRANSFER_REQUEST_BYTES,
  nativeTransferCommandSchema,
  nativeTransferReplySchema,
  nativeTransferReplyStatus,
  type NativeTransferCommand,
} from '@boardsesh/auth-protocol/native-oauth-transfer';
import { getCredentialDatabase } from '../auth/credential-database';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import { claimBrowserNativeTransfer, readBrowserNativeTransfer } from '../auth/current-store/native-transfer';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import { checkRateLimit } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Default-off, service-authenticated transport; no public token or browser origin grants access. */
export async function handleCurrentStoreNativeTransfer(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  let configuration: {
    authority: ReturnType<typeof currentStoreAuthorityConfiguration>;
    rpcSecret: string;
    transferSecret: string;
  };
  try {
    if (
      parseWebAuthMode(process.env[AUTH_COMMAND_ENV.mode]) === 'legacy' ||
      parseBrowserSessionMode(process.env.AUTH_BROWSER_SESSION_MODE) !== 'legacy'
    ) {
      sendJson(response, 404, { error: 'disabled' });
      return;
    }
    const transferSecret = process.env.NEXTAUTH_SECRET;
    if (!transferSecret) throw new Error('Transfer issuer key unavailable');
    configuration = {
      authority: currentStoreAuthorityConfiguration(process.env),
      rpcSecret: currentStoreRpcSecret(process.env),
      transferSecret,
    };
  } catch {
    sendJson(response, 503, { error: 'disabled' });
    return;
  }
  if (
    !authenticatesPrivateAuth(request.headers.authorization, configuration.rpcSecret) ||
    request.headers.origin !== undefined
  ) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (
    request.url !== NATIVE_TRANSFER_COMMAND_PATH ||
    request.method !== 'POST' ||
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  ) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  let command: NativeTransferCommand;
  try {
    const parsed = nativeTransferCommandSchema.safeParse(
      await readPrivateAuthCommand(request, NATIVE_TRANSFER_REQUEST_BYTES),
    );
    if (!parsed.success) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    command = parsed.data;
  } catch {
    if (!response.destroyed) sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!isWebPasswordCommandFresh(command.issuedAt)) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    const source = readBrowserNativeTransfer(command.payload.transferToken, configuration.transferSecret);
    if (!source) {
      sendJson(response, 401, {
        nativeTransferProtocolVersion: NATIVE_TRANSFER_PROTOCOL_VERSION,
        operation: 'claim',
        requestId: command.requestId,
        outcome: 'denied',
      });
      return;
    }
    // Only an independently verified owner allocates a budget. Token/request
    // variants share one key; replaying A cannot spend B's allowance. The
    // existing limiter expires these process-local entries under its TTL cleanup.
    const ownerKey = createHash('sha256').update(source.userId).digest('hex');
    checkRateLimit(`current-store-native-transfer:${ownerKey}`, 180, 60_000);
    const commandDatabase = database ?? (await getCredentialDatabase('private-web-v1'));
    const reply = nativeTransferReplySchema.parse(
      await claimBrowserNativeTransfer(commandDatabase, configuration.authority, command, configuration.transferSecret),
    );
    sendJson(response, nativeTransferReplyStatus(reply), reply);
  } catch {
    // Exceptions can contain the signed capability. Only a fixed category leaves this boundary.
    logger.warn('Browser native-transfer command unavailable', { type: 'native_transfer_unavailable' });
    sendJson(response, 503, {
      nativeTransferProtocolVersion: NATIVE_TRANSFER_PROTOCOL_VERSION,
      operation: 'claim',
      requestId: command.requestId,
      outcome: 'unavailable',
    });
  }
}
