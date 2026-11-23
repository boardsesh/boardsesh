import { GraphQLError, Kind, type GraphQLFieldResolver, type GraphQLResolveInfo, type GraphQLSchema } from 'graphql';
import type { ConnectionContext, OfflineWriteRelease } from '@boardsesh/shared-schema';
import {
  OFFLINE_WRITE_OPERATIONS,
  offlineWriteBindingHash,
  recordOfflineWriteVerdict,
  type OfflineWriteOperation,
  type OfflineWriteVerdict,
} from '../services/offline-write-delivery';
import { logger } from '../utils/logger';
import { OfflineWriteReleaseSchema } from '../validation/schemas/offline-write-delivery';

const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Malformed optional measurement metadata must never reject an otherwise valid write. */
export function parseOfflineWriteDeliveryId(candidate: string | null): string | undefined {
  return candidate !== null && DELIVERY_ID_PATTERN.test(candidate) ? candidate.toLowerCase() : undefined;
}

export function parseOfflineWriteRelease(candidate: string | null): OfflineWriteRelease | undefined {
  if (candidate === null || candidate.length > 2048) return undefined;
  try {
    const parsed = OfflineWriteReleaseSchema.safeParse(JSON.parse(candidate) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isSingleRootMutation(info: GraphQLResolveInfo): boolean {
  const selections = info.operation.selectionSet.selections;
  return (
    info.operation.operation === 'mutation' &&
    selections.length === 1 &&
    selections[0]?.kind === Kind.FIELD &&
    selections[0].name.value === info.fieldName
  );
}

// These are resolver pre-write verdicts. Generic INTERNAL_SERVER_ERROR, network,
// permission and post-commit failures are ambiguous and never establish rejection.
const PRECOMMIT_REJECTIONS = new Set(['BAD_USER_INPUT', 'VALIDATION_ERROR', 'CLIMB_NOT_FOUND', 'TICK_UUID_CONFLICT']);

type DeliveryResolver = GraphQLFieldResolver<unknown, ConnectionContext, Record<string, unknown>>;

export function observeOfflineWriteResolver(
  operation: OfflineWriteOperation,
  resolver: DeliveryResolver,
  recordVerdict: (verdict: OfflineWriteVerdict) => Promise<void> = recordOfflineWriteVerdict,
): DeliveryResolver {
  return async (source, args, context, info) => {
    const deliveryId = context.offlineWriteDeliveryId;
    const userId = context.isAuthenticated ? context.userId : undefined;
    const observed =
      deliveryId !== undefined && userId !== undefined && context.transport === 'http' && isSingleRootMutation(info);
    const identity = observed
      ? {
          userId,
          deliveryId,
          operation,
          bindingHash: offlineWriteBindingHash(operation, args),
          receivingRelease: context.offlineWriteRelease,
        }
      : null;
    const recordSafely = async (verdict: OfflineWriteVerdict): Promise<void> => {
      try {
        await recordVerdict(verdict);
      } catch {
        // Do not log the private identity or payload. A missing receipt remains unknown.
        logger.warn('[offline-write-delivery] Could not persist a server receipt', { operation });
      }
    };
    let result: unknown;
    try {
      result = await resolver(source, args, context, info);
    } catch (error) {
      if (
        identity &&
        error instanceof GraphQLError &&
        typeof error.extensions.code === 'string' &&
        PRECOMMIT_REJECTIONS.has(error.extensions.code)
      ) {
        await recordSafely({ ...identity, accepted: false, rejectionCode: error.extensions.code });
      }
      throw error;
    }
    if (identity && result !== undefined && result !== null) await recordSafely({ ...identity, accepted: true });
    return result;
  };
}

export function instrumentOfflineWriteDelivery(schema: GraphQLSchema): void {
  const fields = schema.getMutationType()?.getFields();
  if (!fields) return;
  for (const operation of Object.keys(OFFLINE_WRITE_OPERATIONS) as OfflineWriteOperation[]) {
    const field = fields[operation];
    if (field?.resolve) field.resolve = observeOfflineWriteResolver(operation, field.resolve);
  }
}
