// Favorites types

export type ToggleFavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export type ToggleFavoriteResult = {
  favorited: boolean;
};

export type AddFavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export type RemoveFavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};
