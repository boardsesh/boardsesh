import {
  FIRST_PASSWORD_VERSION,
  firstPasswordCommandSchema,
  firstPasswordReplySchema,
  type FirstPasswordCommand,
  type FirstPasswordReply,
} from '@boardsesh/auth-protocol';
import type { AuthorityDatabase } from './adapter';
import { captureFirstPasswordRuntime, type FirstPasswordRuntime } from './first-password-policy';
import {
  captureFirstPasswordActor,
  FirstPasswordRefusal,
  lockFirstPasswordEligibility,
  withFirstPasswordAuthority,
} from './first-password-context';
import { requestFirstPasswordChallenge, readFirstPasswordChallenge } from './first-password-challenges';
import {
  prepareFirstPasswordChallenge,
  finalizeFirstPasswordChallenge,
  acknowledgeFirstPasswordResult,
} from './first-password-finalizer';
import { ProviderSecurityRefusal, providerTokenHash } from './provider-security-context';
import { checkRateLimit } from '../../utils/rate-limiter';
import { isWebPasswordCommandFresh } from '../current-store/command-context';

/** Only admitted actual possession is charged against account-level costly work. */
async function boundFirstPasswordWork(
  database: AuthorityDatabase,
  runtime: FirstPasswordRuntime,
  command: FirstPasswordCommand,
) {
  const actor = captureFirstPasswordActor(command.payload.actor, runtime);
  const admitted = await withFirstPasswordAuthority(database, runtime, (transaction, authority) =>
    lockFirstPasswordEligibility(transaction, authority, runtime, actor),
  );
  checkRateLimit(
    `first-password:${command.operation}:${providerTokenHash(admitted.session.userId)}`,
    command.operation === 'request' ? 3 : 5,
    60_000,
  );
}
export async function executeFirstPasswordCommand(
  database: AuthorityDatabase,
  runtimeInput: FirstPasswordRuntime,
  input: FirstPasswordCommand,
): Promise<FirstPasswordReply> {
  const runtime = captureFirstPasswordRuntime(runtimeInput);
  const command = firstPasswordCommandSchema.parse(input);
  const base = {
    firstPasswordVersion: FIRST_PASSWORD_VERSION,
    requestId: command.requestId,
    operation: command.operation,
  };
  let result: unknown;
  try {
    if (!isWebPasswordCommandFresh(Date.parse(command.issuedAt))) throw new FirstPasswordRefusal('denied', 'expired');
    if (command.operation === 'request' || command.operation === 'prepare')
      await boundFirstPasswordWork(database, runtime, command);
    switch (command.operation) {
      case 'request':
        result = await requestFirstPasswordChallenge(database, runtime, command.payload);
        break;
      case 'read':
        result = await readFirstPasswordChallenge(database, runtime, command.payload);
        break;
      case 'prepare':
        result = await prepareFirstPasswordChallenge(database, runtime, command.payload);
        break;
      case 'finalize':
        result = await finalizeFirstPasswordChallenge(database, runtime, command.payload);
        break;
      case 'recover':
        result = await acknowledgeFirstPasswordResult(database, runtime, command.payload);
        break;
    }
  } catch (error) {
    if (error instanceof FirstPasswordRefusal || error instanceof ProviderSecurityRefusal)
      result = { outcome: error.outcome, code: error.code };
    else throw error;
  }
  const serialized: unknown = JSON.parse(JSON.stringify({ ...base, ...(result as Record<string, unknown>) }));
  return firstPasswordReplySchema.parse(serialized);
}
