import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import { users } from '@boardsesh/db/schema/auth';
import {
  BROWSER_BINDING_COMMAND_PATHS,
  BROWSER_BINDING_PROTOCOL_VERSION,
  BROWSER_BINDING_REQUEST_BYTES,
  BROWSER_BINDING_RESPONSE_BYTES,
  browserBindingMode,
  browserBindingCommandSchema,
  browserBindingReplySchema,
  browserBindingReplyStatus,
  type BrowserBindingCommand,
  type BrowserBindingReply,
  type BrowserSourceCredential,
  type BrowserSelectionPossession,
} from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  beginBrowserIntent,
  commitBrowserLogin,
  commitBrowserLogout,
  createUnpublishedBrowserBinding,
  describeBrowserBinding,
  readBrowserBindingInTransaction,
  type BrowserBindingCursor,
  type BrowserSelectionCredential,
} from '../auth/authority/browser-binding';
import type { FirstPartyCredential, FirstPartySession } from '../auth/authority/session-reader';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityQualification,
} from '../auth/authority/router';
import { transactionSettings } from '../auth/current-store/command-context';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import { isWebPasswordCommandFresh } from '../auth/current-store/web-password';
import { getCredentialDatabase } from '../auth/credential-database';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

function sourceCredential(source: BrowserSourceCredential): FirstPartyCredential {
  if (source.kind === 'canonical-token') return { ...source };
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('Browser source authority unavailable');
  return { ...source, secret };
}
function possession(actor: BrowserSelectionPossession | undefined): BrowserSelectionCredential | undefined {
  return actor ? { version: actor.version, credential: sourceCredential(actor.credential) } : undefined;
}
function serializeCursor(cursor: BrowserBindingCursor) {
  return { ...cursor, bindingExpiresAt: cursor.bindingExpiresAt.toISOString() };
}
function serializeSession(session: FirstPartySession | null) {
  return session
    ? {
        ...session,
        authenticatedAt: session.authenticatedAt?.toISOString() ?? null,
        expiresAt: session.expiresAt.toISOString(),
      }
    : null;
}

async function runCommand(
  database: DbInstance,
  authority: IdentityAuthorityQualification,
  command: BrowserBindingCommand,
): Promise<BrowserBindingReply> {
  const base = {
    browserBindingProtocolVersion: BROWSER_BINDING_PROTOCOL_VERSION,
    requestId: command.requestId,
  } as const;
  if (command.operation === 'bootstrap') {
    const result = await createUnpublishedBrowserBinding(database, authority);
    return result.status === 'created'
      ? {
          ...base,
          operation: 'bootstrap',
          outcome: 'created',
          token: result.token,
          cursor: serializeCursor(result.cursor),
        }
      : { ...base, operation: 'bootstrap', outcome: result.status };
  }
  if (command.operation === 'describe') {
    const result = await describeBrowserBinding(database, authority, command.payload.bindingToken);
    return result.status === 'known'
      ? {
          ...base,
          operation: 'describe',
          outcome: 'known',
          state: result.state,
          cursor: serializeCursor(result.cursor),
          credentialKind: result.credentialKind,
        }
      : { ...base, operation: 'describe', outcome: result.status };
  }
  if (command.operation === 'read') {
    const actor = possession(command.payload.actor);
    return database.transaction(async (transaction): Promise<BrowserBindingReply> => {
      await transactionSettings(transaction);
      const receipt = await captureIdentityAuthority(transaction, authority);
      const result = await readBrowserBindingInTransaction(transaction, receipt, {
        bindingToken: command.payload.bindingToken,
        actor,
      });
      if (result.status === 'anonymous')
        return { ...base, operation: 'read', outcome: 'anonymous', cursor: serializeCursor(result.cursor) };
      if (result.status !== 'admitted') return { ...base, operation: 'read', outcome: result.status };
      const [user] = await transaction
        .select({ id: users.id, email: users.email, name: users.name, image: users.image })
        .from(users)
        .where(eq(users.id, result.session.userId));
      if (!user) return { ...base, operation: 'read', outcome: 'denied' };
      await revalidateIdentityAuthority(transaction, receipt);
      const session = serializeSession(result.session);
      if (!session) throw new Error('Browser admitted session unavailable');
      return { ...base, operation: 'read', outcome: 'admitted', cursor: serializeCursor(result.cursor), session, user };
    });
  }
  const actor = possession(command.payload.actor);
  if (command.operation === 'intent') {
    const result = await beginBrowserIntent(database, authority, command.payload.bindingToken, {
      operation: command.payload.transition,
      expectedVersion: command.payload.expectedVersion,
      expectedIdentity: command.payload.expectedIdentity,
      presented: actor,
    });
    return result.status === 'prepared'
      ? {
          ...base,
          operation: 'intent',
          outcome: 'prepared',
          intentToken: result.intentToken,
          cursor: serializeCursor(result.cursor),
          expiresAt: result.expiresAt.toISOString(),
        }
      : { ...base, operation: 'intent', outcome: result.status };
  }
  const result =
    command.operation === 'login'
      ? await commitBrowserLogin(
          database,
          authority,
          command.payload.bindingToken,
          command.payload.intentToken,
          sourceCredential(command.payload.candidate),
          actor,
        )
      : await commitBrowserLogout(
          database,
          authority,
          command.payload.bindingToken,
          command.payload.intentToken,
          actor,
        );
  return result.status === 'committed' || result.status === 'already-committed'
    ? {
        ...base,
        operation: command.operation,
        outcome: result.status,
        cursor: serializeCursor(result.cursor),
        session: serializeSession(result.session),
      }
    : { ...base, operation: command.operation, outcome: result.status };
}

/** Default-off private transport only. It emits no browser cookies, never
 * invokes a public bootstrap and never accepts a content database fallback. */
export async function handleBrowserBinding(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  response.setHeader('Cache-Control', 'private, no-store');
  let rpcSecret: string;
  let authority: IdentityAuthorityQualification;
  try {
    if (browserBindingMode(process.env) !== 'backend-staging') {
      sendJson(response, 404, { error: 'disabled' });
      return;
    }
    rpcSecret = currentStoreRpcSecret(process.env);
    authority = currentStoreAuthorityConfiguration(process.env);
  } catch {
    sendJson(response, 503, { error: 'unavailable' });
    return;
  }
  if (!authenticatesPrivateAuth(request.headers.authorization, rpcSecret)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const parsed = browserBindingCommandSchema.safeParse(
    await readPrivateAuthCommand(request, BROWSER_BINDING_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (request.url?.split('?')[0] !== BROWSER_BINDING_COMMAND_PATHS[command.operation]) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!isWebPasswordCommandFresh(command.issuedAt)) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    checkRateLimit(
      `browser-binding:${command.operation}`,
      command.operation === 'read' || command.operation === 'describe' ? 600 : 180,
      60_000,
    );
    const commandDatabase = database ?? (await getCredentialDatabase('private-browser-v1'));
    const reply = browserBindingReplySchema.parse(await runCommand(commandDatabase, authority, command));
    if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > BROWSER_BINDING_RESPONSE_BYTES)
      throw new Error('Browser reply exceeds its private transport budget');
    sendJson(response, browserBindingReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, {
      browserBindingProtocolVersion: BROWSER_BINDING_PROTOCOL_VERSION,
      operation: command.operation,
      requestId: command.requestId,
      outcome: 'unavailable',
    });
  }
}
