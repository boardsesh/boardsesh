import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { UPDATE_PROFILE, UPDATE_STANDINGS_PRIVACY } from '../operations';

/** The profile contract before standings privacy shipped on the backend. */
const olderBackend = buildSchema(`
  type Query { health: Boolean }
  type UserProfile {
    id: ID!
    email: String!
    displayName: String
    avatarUrl: String
    isTester: Boolean!
  }
  input UpdateProfileInput { displayName: String, avatarUrl: String }
  type Mutation { updateProfile(input: UpdateProfileInput!): UserProfile! }
`);

describe('profile editing compatibility before the standings backend deploy', () => {
  it('keeps ordinary name and avatar edits valid against the older profile schema', () => {
    expect(validate(olderBackend, parse(UPDATE_PROFILE))).toEqual([]);
  });

  it('isolates new consent fields to the dedicated privacy write', () => {
    const errors = validate(olderBackend, parse(UPDATE_STANDINGS_PRIVACY));
    expect(errors.map((error) => error.message)).toEqual([
      'Cannot query field "leaderboardVisibility" on type "UserProfile".',
      'Cannot query field "gymScreenVisibility" on type "UserProfile".',
    ]);
  });
});
