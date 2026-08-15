// Favorites types.
//
// Favorites are keyed by (userId, climbUuid). `boardName`/`angle` are optional
// and ignored — they only exist so binaries shipped before the re-keying (and
// favorite mutations already queued in a device's offline outbox) keep
// validating. Removed once the store fleet has rolled past this release.

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
