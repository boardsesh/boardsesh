import { gql } from 'graphql-request';

// Boardsesh's setter autocomplete. Mobile keeps its query in its own files, so
// Boardz carries its own copy.
export const SEARCH_SETTERS = gql`
  query SearchSetters($input: SetterStatsInput!) {
    setterStats(input: $input) {
      setterUsername
      climbCount
    }
  }
`;

export type SearchSettersResponse = { setterStats: { setterUsername: string; climbCount: number }[] };
