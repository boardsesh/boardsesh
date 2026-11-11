import postgres from 'postgres';
import { explicitReadOnlyConnectionOptions } from '../../auth/email-audit/connection';

export function operatorConnectionOptions(
  environment: Readonly<Record<string, string | undefined>>,
  confirmHost: string,
  write: boolean,
) {
  const options = explicitReadOnlyConnectionOptions(environment.AUTH_OPERATOR_DATABASE_URL, environment.DEBUG_SQL, {
    applicationName: 'boardsesh_auth_operator',
    targetSessionAttrs: 'primary',
    statementTimeoutMs: 30000,
    lockTimeoutMs: 2000,
    idleInTransactionTimeoutMs: 10000,
    maxLifetimeSeconds: 120,
  });
  if (!confirmHost || options.host !== confirmHost) throw new Error('HOST_CONFIRMATION_REQUIRED');
  return { ...options, connection: { ...options.connection, default_transaction_read_only: !write } };
}

export function operatorClient(
  environment: Readonly<Record<string, string | undefined>>,
  confirmHost: string,
  write: boolean,
) {
  return postgres(operatorConnectionOptions(environment, confirmHost, write));
}

export function parseOperatorArguments(arguments_: readonly string[], commands: readonly string[]) {
  const command = arguments_[0]?.startsWith('--') || !arguments_[0] ? commands[0] : arguments_[0];
  if (!commands.includes(command)) throw new Error('INVALID_ARGUMENTS');
  const options = new Map<string, string>();
  const start = arguments_[0] === command ? 1 : 0;
  for (let index = start; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const argument = arguments_[index + 1];
    if (
      !['--confirm-host', '--projection-id', '--plan-sha256'].includes(flag) ||
      !argument ||
      argument.startsWith('--') ||
      options.has(flag)
    )
      throw new Error('INVALID_ARGUMENTS');
    options.set(flag, argument);
  }
  const confirmHost = options.get('--confirm-host');
  if (!confirmHost) throw new Error('HOST_CONFIRMATION_REQUIRED');
  return {
    command,
    confirmHost,
    projectionId: options.get('--projection-id'),
    planSha256: options.get('--plan-sha256'),
  };
}
