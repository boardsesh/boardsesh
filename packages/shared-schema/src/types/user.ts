// User types

export type UserId = string;

export type UserProfile = {
  id: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  isTester: boolean;
  isAdmin: boolean;
  createdAt: string;
  favoriteCount: number;
};

export type UpdateProfileInput = {
  displayName?: string;
  avatarUrl?: string;
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
