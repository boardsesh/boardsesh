import { describe, expect, it } from 'vite-plus/test';
import { buildSchema, findBreakingChanges } from 'graphql';
import { typeDefs } from '../schema';

// Shipped clients keep these documents and input shapes until they update.
// Keep this contract independent of the current generated client operations.
const shippedFavoritesSchema = buildSchema(`
  type Query {
    favorites(boardName: String!, climbUuids: [String!]!, angle: Int!): [String!]!
    userFavoritesCounts: [FavoritesCount!]!
    userActiveBoards: [String!]!
  }
  type Mutation {
    toggleFavorite(input: ToggleFavoriteInput!): ToggleFavoriteResult!
    addFavorite(input: AddFavoriteInput!): Boolean!
    removeFavorite(input: RemoveFavoriteInput!): Boolean!
  }
  type FavoritesCount {
    boardName: String!
    count: Int!
  }
  type ToggleFavoriteResult {
    favorited: Boolean!
  }
  input ToggleFavoriteInput {
    boardName: String!
    climbUuid: String!
    angle: Int!
  }
  input AddFavoriteInput {
    boardName: String!
    climbUuid: String!
    angle: Int!
  }
  input RemoveFavoriteInput {
    boardName: String!
    climbUuid: String!
    angle: Int!
  }
`);

describe('shipped favorites GraphQL contract', () => {
  it('preserves existing fields, response shapes, and accepted legacy inputs', () => {
    const currentSchema = buildSchema(typeDefs.join('\n'));
    expect(findBreakingChanges(shippedFavoritesSchema, currentSchema)).toEqual([]);
  });
});
