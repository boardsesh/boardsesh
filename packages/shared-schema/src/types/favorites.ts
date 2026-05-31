// Favorites types

export type ToggleFavoriteInput = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export type ToggleFavoriteResult = {
  favorited: boolean;
};

// Idempotent, sync-safe favorite mutations (Phase 2). Same field shape as
// ToggleFavoriteInput; separate types keep the resolver signatures explicit.
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
