import {
  BATCH_SYSTEM_USER_COMMAND_ENV,
  BATCH_SYSTEM_USER_COMMAND_PATH,
  BATCH_SYSTEM_USER_COMMAND_TIMEOUT_MS,
  batchSystemUserCommandSchema,
  batchSystemUserReplyStatus,
  currentStoreBatchSystemUsersMode,
  parseBatchSystemUserReply,
  type BatchSystemUserCommand,
} from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError, createPrivateAuthCommandTransport } from '@boardsesh/auth-protocol/transport';

type Environment = Readonly<Record<string, string | undefined>>;

export interface BatchSystemUserClient {
  ensure(command: BatchSystemUserCommand): Promise<void>;
}

/** Dedicated machine command; uncertainty never permits a direct write or automatic retry. */
export function createBatchSystemUserClient(
  options: { environment?: Environment; fetch?: typeof fetch; timeoutMs?: number } = {},
): BatchSystemUserClient {
  try {
    const environment = { ...(options.environment ?? process.env) };
    if (currentStoreBatchSystemUsersMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
    const transport = createPrivateAuthCommandTransport({
      environment,
      fetch: options.fetch ?? fetch,
      timeoutMs: options.timeoutMs ?? BATCH_SYSTEM_USER_COMMAND_TIMEOUT_MS,
      originKey: BATCH_SYSTEM_USER_COMMAND_ENV.origin,
      secretKey: BATCH_SYSTEM_USER_COMMAND_ENV.secret,
      disallowedSecretKeys: ['CURRENT_STORE_AUTH_RPC_SECRET', 'NEXTAUTH_SECRET', 'CRON_SECRET'],
      paths: [BATCH_SYSTEM_USER_COMMAND_PATH],
    });
    return {
      async ensure(commandInput) {
        try {
          // Parse a fresh copy before the first await, so caller mutation cannot
          // change the command or its eventual correlation checks.
          const command = batchSystemUserCommandSchema.parse(commandInput);
          const response = await transport.post(BATCH_SYSTEM_USER_COMMAND_PATH, command);
          const reply = parseBatchSystemUserReply(response.body);
          if (
            reply.requestId !== command.requestId ||
            reply.operation !== command.operation ||
            batchSystemUserReplyStatus(reply) !== response.status ||
            reply.outcome !== 'ensured'
          )
            throw new AuthBackendUnavailableError();
        } catch {
          throw new AuthBackendUnavailableError();
        }
      },
    };
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
