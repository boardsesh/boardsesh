import postgres from 'postgres';
import { explicitReadOnlyConnectionOptions } from '../../auth/email-audit/connection';

/**
 * `identity-writer` connects as the dedicated credential LOGIN from
 * AUTH_IDENTITY_DATABASE_URL (the identity import); every other tool uses the
 * administrative AUTH_OPERATOR_DATABASE_URL. Same TLS, timeout and host rules.
 */
export function operatorConnectionOptions(
  environment: Readonly<Record<string, string | undefined>>,
  confirmHost: string,
  write: boolean,
  login: 'operator' | 'identity-writer' = 'operator',
) {
  const url = login === 'operator' ? environment.AUTH_OPERATOR_DATABASE_URL : environment.AUTH_IDENTITY_DATABASE_URL;
  const options = explicitReadOnlyConnectionOptions(url, environment.DEBUG_SQL, {
    applicationName: login === 'operator' ? 'boardsesh_auth_operator' : 'boardsesh_identity_import',
    targetSessionAttrs: 'primary',
    statementTimeoutMs: 30000,
    lockTimeoutMs: 2000,
    idleInTransactionTimeoutMs: 10000,
    maxLifetimeSeconds: 120,
  });
  if (!confirmHost || options.host !== confirmHost) throw new Error('HOST_CONFIRMATION_REQUIRED');
  return {
    ...options,
    // The LOGIN's qualification compares name[] arrays, which postgres.js parses
    // only once it has read the array types at connect.
    fetch_types: login === 'identity-writer',
    connection: { ...options.connection, default_transaction_read_only: !write },
  };
}

export function operatorClient(
  environment: Readonly<Record<string, string | undefined>>,
  confirmHost: string,
  write: boolean,
) {
  return postgres(operatorConnectionOptions(environment, confirmHost, write));
}

/**
 * `commands[0]` is the default when no verb is given. A command listed in
 * `writeCommands` is never defaulted: it must be named, so a missing verb can
 * only ever select a read-only mode.
 */
export function parseOperatorArguments(
  argumentsWithBoundary: readonly string[],
  commands: readonly string[],
  additionalFlags: readonly string[],
  writeCommands: readonly string[],
) {
  // `vp run <task> -- <arguments>` forwards the `--` itself. Drop that one leading
  // boundary so the documented runbook form and the bare form parse the same.
  const arguments_ = argumentsWithBoundary[0] === '--' ? argumentsWithBoundary.slice(1) : argumentsWithBoundary;
  const named = !!arguments_[0] && !arguments_[0].startsWith('--');
  const command = named ? arguments_[0] : commands[0];
  if (!commands.includes(command)) throw new Error('INVALID_ARGUMENTS');
  if (!named && writeCommands.includes(command)) throw new Error('WRITE_COMMAND_REQUIRED');
  const options = new Map<string, string>();
  const start = named ? 1 : 0;
  for (let index = start; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const argument = arguments_[index + 1];
    if (
      !['--confirm-host', '--projection-id', '--plan-sha256', ...additionalFlags].includes(flag) ||
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
    options,
    confirmHost,
    projectionId: options.get('--projection-id'),
    planSha256: options.get('--plan-sha256'),
  };
}
