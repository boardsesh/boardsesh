import { gql } from 'graphql-request';

export const GET_FAVORITES = gql`
  query Favorites($climbUuids: [String!]!) {
    favorites(climbUuids: $climbUuids)
  }
`;

export const TOGGLE_FAVORITE = gql`
  mutation ToggleFavorite($input: ToggleFavoriteInput!) {
    toggleFavorite(input: $input) {
      favorited
    }
  }
`;

// Type for the favorites query variables
export type FavoritesQueryVariables = {
  climbUuids: string[];
};

// Type for the favorites query response
export type FavoritesQueryResponse = {
  favorites: string[];
};

// Type for the toggle favorite mutation variables
export type ToggleFavoriteMutationVariables = {
  input: {
    climbUuid: string;
  };
};

// Type for the toggle favorite mutation response
export type ToggleFavoriteMutationResponse = {
  toggleFavorite: {
    favorited: boolean;
  };
};

// Get user's favorite climbs with full data
export const GET_USER_FAVORITE_CLIMBS = gql`
  query GetUserFavoriteClimbs($input: GetUserFavoriteClimbsInput!) {
    userFavoriteClimbs(input: $input) {
      climbs {
        uuid
        layoutId
        setter_username
        name
        description
        frames
        framesCount
        framesPace
        angle
        ascensionist_count
        difficulty
        quality_average
        stars
        difficulty_error
        benchmark_difficulty
      }
      totalCount
      hasMore
    }
  }
`;

export type GetUserFavoriteClimbsInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  page?: number;
  pageSize?: number;
};

export type GetUserFavoriteClimbsQueryVariables = {
  input: GetUserFavoriteClimbsInput;
};

export type UserFavoriteClimbsResult = {
  climbs: Array<{
    uuid: string;
    layoutId?: number | null;
    setter_username: string;
    name: string;
    description: string;
    frames: string;
    framesCount?: number | null;
    framesPace?: number | null;
    angle: number;
    ascensionist_count: number;
    difficulty: string;
    quality_average: string;
    stars: number;
    difficulty_error: string;
    benchmark_difficulty: string | null;
  }>;
  totalCount: number;
  hasMore: boolean;
};

export type GetUserFavoriteClimbsQueryResponse = {
  userFavoriteClimbs: UserFavoriteClimbsResult;
};
