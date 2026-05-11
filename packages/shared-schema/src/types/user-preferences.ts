// User preferences types

export type UserPreference = {
  key: string;
  value: unknown;
  updatedAt: string;
};

export type SetUserPreferenceInput = {
  key: string;
  value: unknown;
};
