import { gql } from 'graphql-request';

// Mobile keeps this query in its own operations file, not @boardsesh/graphql,
// so Boardz carries its own copy.
export const GET_PROFILE = gql`
  query GetProfile {
    profile {
      id
      email
      displayName
      avatarUrl
    }
  }
`;

export type Profile = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type GetProfileResponse = { profile: Profile | null };
