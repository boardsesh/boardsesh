import {
  PROVIDER_SECURITY_VERSION,
  providerSecurityCommandSchema,
  providerSecurityReplySchema,
  type ProviderSecurityCommand,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';
import type { AuthorityDatabase } from './adapter';
import {
  admitProviderActorInTransaction,
  captureProviderActor,
  providerTokenHash,
  ProviderSecurityRefusal,
} from './provider-security-context';
import {
  bindProviderSecurityFlow,
  captureProviderSecurityRuntime,
  createProviderSecurityIntent,
  readProviderSecurityMethods,
  withProviderSecurityAuthority,
  type ProviderSecurityRuntime,
} from './provider-security-intents';
import {
  reauthenticateProviderWithGoogle,
  reauthenticateProviderWithPassword,
} from './provider-security-reauthentication';
import { finalizeProviderSecurityMutation, prepareProviderSecurityMutation } from './provider-security-finalizer';
import { abortProviderSecurityMutation, acknowledgeProviderSecurityResult } from './provider-security-terminal';
import { checkRateLimit } from '../../utils/rate-limiter';
import { admitOwnedProviderForRenewal } from './provider-security-owned-provider';
import { isWebPasswordCommandFresh } from '../current-store/command-context';
import {
  abortOwnedProviderSignin,
  beginOwnedProviderSignin,
  finalizeOwnedProviderSignin,
  prepareOwnedProviderSignin,
} from './provider-owned-signin';

/** Per-account work is charged only after actual source possession is admitted. */
async function boundReauthenticationWork(
  database: AuthorityDatabase,
  runtime: ProviderSecurityRuntime,
  input: ProviderSecurityCommand['payload']['actor'],
) {
  const actor = captureProviderActor(input, runtime.legacySecret);
  const userId = await withProviderSecurityAuthority(
    database,
    runtime,
    async (transaction, authority) =>
      (await admitProviderActorInTransaction(transaction, authority, actor)).session.userId,
  );
  checkRateLimit(`provider-security-reauthentication:${providerTokenHash(userId)}`, 5, 60_000);
}

/** An authenticated private adapter owns transport/size/profile checks; this core has no content-pool fallback. */
export async function executeProviderSecurityCommand(
  database: AuthorityDatabase,
  runtimeInput: ProviderSecurityRuntime,
  input: ProviderSecurityCommand,
): Promise<ProviderSecurityReply> {
  const runtime = captureProviderSecurityRuntime(runtimeInput);
  const command = providerSecurityCommandSchema.parse(input);
  const base = {
    providerSecurityVersion: PROVIDER_SECURITY_VERSION,
    requestId: command.requestId,
    operation: command.operation,
  };
  if (!isWebPasswordCommandFresh(Date.parse(command.issuedAt))) throw new ProviderSecurityRefusal('denied', 'expired');
  let result: unknown;
  try {
    switch (command.operation) {
      case 'signin-intent':
        result = await beginOwnedProviderSignin(database, runtime, command.payload);
        break;
      case 'signin-prepare':
        result = await prepareOwnedProviderSignin(database, runtime, command.payload);
        break;
      case 'signin-finalize':
        result = await finalizeOwnedProviderSignin(database, runtime, command.payload);
        break;
      case 'signin-abort':
        result = await abortOwnedProviderSignin(database, runtime, command.payload);
        break;
      case 'owned-provider':
        result = await admitOwnedProviderForRenewal(database, runtime, command.payload);
        break;
      case 'methods':
        result = {
          outcome: 'available',
          ...(await readProviderSecurityMethods(database, runtime, command.payload.actor)),
        };
        break;
      case 'intent':
        result = { outcome: 'recorded', ...(await createProviderSecurityIntent(database, runtime, command.payload)) };
        break;
      case 'bind':
      case 'bind-google-reauthentication':
        result = await bindProviderSecurityFlow(database, runtime, command.payload);
        break;
      case 'reauthenticate-password':
        await boundReauthenticationWork(database, runtime, command.payload.actor);
        result = {
          outcome: 'proved',
          ...(await reauthenticateProviderWithPassword(database, runtime, command.payload)),
        };
        break;
      case 'reauthenticate-google':
        await boundReauthenticationWork(database, runtime, command.payload.actor);
        result = { outcome: 'proved', ...(await reauthenticateProviderWithGoogle(database, runtime, command.payload)) };
        break;
      case 'prepare':
        result = await prepareProviderSecurityMutation(database, runtime, command.payload);
        break;
      case 'finalize':
        result = await finalizeProviderSecurityMutation(database, runtime, command.payload);
        break;
      case 'abort':
        result = await abortProviderSecurityMutation(database, runtime, command.payload);
        break;
      case 'recover':
        result = await acknowledgeProviderSecurityResult(database, runtime, command.payload);
        break;
    }
  } catch (error) {
    if (error instanceof ProviderSecurityRefusal) result = { outcome: error.outcome, code: error.code };
    else throw error;
  }
  // Only typed reply fields are serialized. Dates become ISO strings; errors,
  // SQL parameters, source credentials and nested causes never enter a reply.
  const serialized: unknown = JSON.parse(JSON.stringify({ ...base, ...(result as Record<string, unknown>) }));
  return providerSecurityReplySchema.parse(serialized);
}
