import type { ConnectionContext, RecordOfflineWriteObservationsResult } from '@boardsesh/shared-schema';
import { recordOfflineWriteObservation } from '../../../services/offline-write-delivery';
import { RecordOfflineWriteObservationsInputSchema } from '../../../validation/schemas/offline-write-delivery';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { GraphQLError } from 'graphql';

export const offlineWriteDeliveryMutations = {
  recordOfflineWriteObservations: async (
    _: unknown,
    { input }: { input: unknown },
    context: ConnectionContext,
  ): Promise<RecordOfflineWriteObservationsResult> => {
    requireAuthenticated(context);
    await applyRateLimit(context, 120, 'offline-write-observations');
    const { ownerUserId, observations } = validateInput(RecordOfflineWriteObservationsInputSchema, input, 'input');
    if (ownerUserId !== context.userId) {
      throw new GraphQLError('Offline observations belong to another account', { extensions: { code: 'FORBIDDEN' } });
    }
    const receipts: RecordOfflineWriteObservationsResult['receipts'] = [];
    for (const observation of observations) {
      const receipt = await recordOfflineWriteObservation(context.userId!, observation);
      if (receipt) receipts.push(receipt);
    }
    return { receipts };
  },
};
