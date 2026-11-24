import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { gymMcpWriteReceipts } from '@boardsesh/db/schema/auth';
import { db } from '../../db/client';
import { getPostgresErrorCode, isUniqueViolation } from '../../utils/postgres-errors';
import { withGymMcpWrite, type GymMcpPrincipal, type GymMcpScope } from './auth';
import { findGymMcpTool, type GymMcpAuthorizedAction } from './registry';
import type { GymToolResult } from './domain';

class GymMcpReceiptConflict extends Error {}

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
  const executeWrite = async () => {
    const receiptKey = and(
      eq(gymMcpWriteReceipts.userId, principal.userId),
      eq(gymMcpWriteReceipts.clientId, principal.clientId),
      eq(gymMcpWriteReceipts.connectionGeneration, principal.connectionGeneration),
      eq(gymMcpWriteReceipts.idempotencyKey, idempotencyKey),
    );
    const [receipt] = await db.select().from(gymMcpWriteReceipts).where(receiptKey).limit(1);
    const matchedReplay =
      receipt !== undefined && receipt.operationName === operationName && receipt.inputHash === inputHash;
    await authorize?.(matchedReplay);
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
    try {
      await db.insert(gymMcpWriteReceipts).values({
        userId: principal.userId,
        clientId: principal.clientId,
        connectionGeneration: principal.connectionGeneration,
        idempotencyKey,
        operationName,
        inputHash,
        result,
      });
    } catch (error) {
      // This insert has only the receipt identity's unique constraint. A
      // concurrent commit may be invisible to a repeatable-read snapshot.
      if (isUniqueViolation(error)) throw new GymMcpReceiptConflict('A concurrent retry committed this action.');
      throw error;
    }
    return result;
  };
  // PostgreSQL savepoints cannot change isolation. Select the grade collection
  // resolver's snapshot level before the outer OAuth and receipt reads begin.
  if (operationName !== 'set_gym_grade_collection') return withGymMcpWrite(principal, requiredScope, executeWrite);
  const executeSnapshotWrite = () =>
    withGymMcpWrite(principal, requiredScope, executeWrite, { isolationLevel: 'repeatable read' });
  try {
    return await executeSnapshotWrite();
  } catch (error) {
    // The failed outer transaction rolled back its mutation and queued effects.
    // A fresh snapshot can now replay the winning receipt after reauthorization.
    // The grade resolver translates serialization/lock failures into its public
    // TEMPORARILY_UNAVAILABLE error before GraphQL returns them.
    const retryable =
      error instanceof GymMcpReceiptConflict ||
      getPostgresErrorCode(error) === '40001' ||
      (error instanceof GraphQLError && error.extensions.code === 'TEMPORARILY_UNAVAILABLE');
    if (!retryable) throw error;
    return executeSnapshotWrite();
  }
}

export async function executeGymMcpTool(
  principal: GymMcpPrincipal,
  name: string,
  arguments_: unknown,
): Promise<GymToolResult> {
  const tool = findGymMcpTool(name);
  if (!tool) throw new GraphQLError('Unknown gym tool.', { extensions: { code: 'BAD_USER_INPUT' } });
  if (!principal.scopes.includes(tool.scope)) {
    throw new GraphQLError(`Reconnect to Boardsesh and request ${tool.scope} to use ${tool.name}.`, {
      extensions: { code: 'FORBIDDEN', requiredScope: tool.scope },
    });
  }
  const parsedArguments = tool.inputSchema.parse(arguments_);
  const context = createGymMcpContext(principal);
  let prepared: GymMcpAuthorizedAction | undefined;
  const work = () => {
    if (!prepared) throw new Error('The gym action was not prepared in its transaction.');
    return prepared();
  };
  return tool.readOnly
    ? tool.run(parsedArguments, context)
    : executeGymMcpWriteAction(principal, tool.name, parsedArguments, tool.scope, work, async (replay) => {
        prepared = undefined;
        prepared = await tool.authorize(parsedArguments, context, replay);
      });
}
