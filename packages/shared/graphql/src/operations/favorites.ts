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

export type FavoritesQueryVariables = {
  climbUuids: string[];
};

export type FavoritesQueryResponse = {
  favorites: string[];
};

export type ToggleFavoriteMutationVariables = {
  input: {
    climbUuid: string;
  };
};

export type ToggleFavoriteMutationResponse = {
  toggleFavorite: {
    favorited: boolean;
  };
};

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
