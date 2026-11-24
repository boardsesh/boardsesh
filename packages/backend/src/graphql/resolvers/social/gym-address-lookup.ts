import { GraphQLError } from 'graphql';
import type { ConnectionContext, GymAddressCoordinates } from '@boardsesh/shared-schema';
import { lookupAddressCoordinates } from '../../../services/gym-address-location';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';

export const gymAddressLookupQueries = {
  lookupGymAddressCoordinates: async (
    _: unknown,
    { address }: { address: string },
    ctx: ConnectionContext,
  ): Promise<GymAddressCoordinates | null> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'lookupGymAddressCoordinates');
    const trimmedAddress = typeof address === 'string' ? address.trim() : '';
    if (trimmedAddress.length < 5 || trimmedAddress.length > 500) {
      throw new GraphQLError('Enter an address between 5 and 500 characters', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    return lookupAddressCoordinates(trimmedAddress);
  },
};
