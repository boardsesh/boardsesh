import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { gymMcpWriteReceipts } from '@boardsesh/db/schema/auth';
import { db } from '../../db/client';
import { withGymMcpWrite, type GymMcpPrincipal, type GymMcpScope } from './auth';
import { findGymMcpTool } from './registry';
import type { GymToolResult } from './domain';

/** Stable JSON ignores object-key order but preserves array order and actual values. */
export function gymMcpInputHash(input: unknown): string {
  function normalized(candidate: unknown): unknown {
    if (Array.isArray(candidate)) return candidate.map(normalized);
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.entries(candidate)
          .filter(([key, entry]) => key !== 'idempotencyKey' && entry !== undefined)
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([key, entry]) => [key, normalized(entry)]),
      );
    }
    return candidate;
  }
  return createHash('sha256')
    .update(JSON.stringify(normalized(input)))
    .digest('hex');
}

export function createGymMcpContext(principal: GymMcpPrincipal): ConnectionContext {
  return {
    connectionId: `gym-mcp-${randomUUID()}`,
    transport: 'http',
    userId: principal.userId,
    isAuthenticated: true,
    authCredentialProvided: true,
    isCronAuthenticated: false,
  };
}

/** Metadata only: media retries can avoid fetching a URL whose image was already saved. */
export async function hasGymMcpWriteReceipt(principal: GymMcpPrincipal, idempotencyKey: string): Promise<boolean> {
  const [receipt] = await db
    .select({ idempotencyKey: gymMcpWriteReceipts.idempotencyKey })
    .from(gymMcpWriteReceipts)
    .where(
      and(
        eq(gymMcpWriteReceipts.userId, principal.userId),
        eq(gymMcpWriteReceipts.clientId, principal.clientId),
        eq(gymMcpWriteReceipts.connectionGeneration, principal.connectionGeneration),
        eq(gymMcpWriteReceipts.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return receipt !== undefined;
}

/** Also used by media tools, whose bounded network preparation happens before the transaction. */
export async function executeGymMcpWriteAction(
  principal: GymMcpPrincipal,
  operationName: string,
  parsedArguments: Record<string, unknown>,
  requiredScope: GymMcpScope,
  work: () => Promise<GymToolResult>,
  authorize?: (replay: boolean) => Promise<void>,
): Promise<GymToolResult> {
  const idempotencyKey = parsedArguments.idempotencyKey;
  if (typeof idempotencyKey !== 'string') {
    throw new GraphQLError('An idempotency UUID is required for gym changes.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  const inputHash = gymMcpInputHash(parsedArguments);
  return withGymMcpWrite(principal, requiredScope, async () => {
    const receiptKey = and(
      eq(gymMcpWriteReceipts.userId, principal.userId),
      eq(gymMcpWriteReceipts.clientId, principal.clientId),
      eq(gymMcpWriteReceipts.connectionGeneration, principal.connectionGeneration),
      eq(gymMcpWriteReceipts.idempotencyKey, idempotencyKey),
    );
    const [receipt] = await db.select().from(gymMcpWriteReceipts).where(receiptKey).limit(1);
    await authorize?.(receipt !== undefined);
    if (receipt) {
      if (receipt.expiresAt.getTime() <= Date.now() || receipt.result === null) {
        throw new GraphQLError('That retry key has expired. Check the gym before starting a new action.', {
          extensions: { code: 'IDEMPOTENCY_EXPIRED' },
        });
      }
      if (receipt.operationName !== operationName || receipt.inputHash !== inputHash) {
        throw new GraphQLError('That retry key was used for a different action. Use a new idempotency UUID.', {
          extensions: { code: 'IDEMPOTENCY_CONFLICT' },
        });
      }
      // The connection lock and bearer check precede replay, so disconnecting
      // immediately prevents both new writes and receipt data access.
      return receipt.result as GymToolResult;
    }
    const result = await work();
    await db.insert(gymMcpWriteReceipts).values({
      userId: principal.userId,
      clientId: principal.clientId,
      connectionGeneration: principal.connectionGeneration,
      idempotencyKey,
      operationName,
      inputHash,
      result,
    });
    return result;
  });
}

export async function executeGymMcpTool(
  principal: GymMcpPrincipal,
  name: string,
  arguments_: unknown,
): Promise<GymToolResult> {
  const tool = findGymMcpTool(name);
  if (!tool) throw new GraphQLError('Unknown gym tool.', { extensions: { code: 'BAD_USER_INPUT' } });
  if (!principal.scopes.includes(tool.scope)) {
    throw new GraphQLError('Reconnect and allow this category of gym actions.', { extensions: { code: 'FORBIDDEN' } });
  }
  const parsedArguments = tool.inputSchema.parse(arguments_);
  const context = createGymMcpContext(principal);
  const work = () => tool.run(parsedArguments, context);
  return tool.readOnly
    ? work()
    : executeGymMcpWriteAction(principal, tool.name, parsedArguments, tool.scope, work, (replay) =>
        tool.authorize(parsedArguments, context, replay),
      );
}
