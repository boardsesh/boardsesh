// User types

export type UserId = string;

/**
 * How much of a climber a ranked surface shows.
 *
 * `anonymous` still ranks and still counts toward the field size — only the
 * identity is withheld. `off` removes them from the denominator too.
 */
export type LeaderboardVisibility = 'public' | 'anonymous' | 'off';

export type UserProfile = {
  id: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  isTester: boolean;
  createdAt: string;
  favoriteCount: number;
  /** Boardsesh's own ranked surfaces. */
  leaderboardVisibility: LeaderboardVisibility;
  /** Gym-operated screens (kiosk rail, wall feeds). Deliberately independent of the above. */
  gymScreenVisibility: LeaderboardVisibility;
};

export type UpdateProfileInput = {
  displayName?: string;
  avatarUrl?: string;
  leaderboardVisibility?: LeaderboardVisibility;
  gymScreenVisibility?: LeaderboardVisibility;
};

export type AuroraCredential = {
  boardType: string;
  username: string;
  userId?: number;
  syncedAt?: string;
  token?: string;
};

export type AuroraCredentialStatus = {
  boardType: string;
  username: string;
  userId?: number;
  syncedAt?: string;
  hasToken: boolean;
};

export type SaveAuroraCredentialInput = {
  boardType: string;
  username: string;
  password: string;
};

export type DeleteAccountInfo = {
  publishedClimbCount: number;
};

export type DeleteAccountInput = {
  removeSetterName: boolean;
};
