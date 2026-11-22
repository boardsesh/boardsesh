import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs } from '@boardsesh/shared-schema';
import { resolvers } from './resolvers/index';
import { instrumentOfflineWriteDelivery } from './offline-write-delivery';

// Create and export schema
export const schema = makeExecutableSchema({ typeDefs, resolvers });
instrumentOfflineWriteDelivery(schema);
