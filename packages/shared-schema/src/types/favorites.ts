// Favorites use (userId, climbUuid) for identity. Optional boardName/angle
// remain storage hints during rollout so shipped clients and queued offline
// mutations keep working against both database schemas.

export type ToggleFavoriteInput = {
  boardName?: string | null;
  climbUuid: string;
  angle?: number | null;
};

export type ToggleFavoriteResult = {
  favorited: boolean;
};

export type AddFavoriteInput = {
  boardName?: string | null;
  climbUuid: string;
  angle?: number | null;
};

export type RemoveFavoriteInput = {
  boardName?: string | null;
  climbUuid: string;
  angle?: number | null;
};
