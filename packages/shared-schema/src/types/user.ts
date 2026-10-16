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
  isAdmin: boolean;
  createdAt: string;
  favoriteCount: number;
  /** Boardsesh's own ranked surfaces. */
  leaderboardVisibility: LeaderboardVisibility;
  /** Additional gym-screen ranking restrictions; cannot widen app or account privacy. */
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
  /** pending | active | error | expired, or 'linked' for a mapping with no credential. */
  syncStatus?: string | null;
  syncError?: string | null;
  /** The queued or running sync this account is waiting on, if any. */
  pendingRunId?: string | null;
  /** Sync now can queue a run for this account. */
  syncAvailable?: boolean | null;
};

/** A "Sync now" request: the run that will sync the account. */
export type ProviderSyncRequest = {
  runId: string;
  /** queued | running | retrying */
  status: string;
  /** True when the request joined a run that was already waiting. */
  coalesced: boolean;
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
