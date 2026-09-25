import { gql } from 'graphql-request';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';

export const SEARCH_PLACES = gql`
  query SearchPlaces($query: String!) {
    searchPlaces(query: $query) {
      id
      name
      region
      country
      countryCode
      latitude
      longitude
    }
  }
`;

export type SearchPlacesQueryResponse = { searchPlaces: PlaceSuggestion[] };
