// User types

export type UserId = string;

export type UserProfile = {
  id: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  instagramUrl?: string;
  hasPassword: boolean;
  linkedProviders: string[];
  isTester: boolean;
  createdAt: string;
  favoriteCount: number;
};

// Omitting a field leaves it untouched; passing null clears it.
export type UpdateProfileInput = {
  displayName?: string | null;
  avatarUrl?: string | null;
  instagramUrl?: string | null;
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
