import { gql } from 'graphql-request';
import type { SetUserPreferenceInput, UserPreference } from '@boardsesh/shared-schema';

export const GET_USER_PREFERENCES = gql`
  query GetUserPreferences {
    userPreferences {
      key
      value
      updatedAt
    }
  }
`;

export const SET_USER_PREFERENCE = gql`
  mutation SetUserPreference($input: SetUserPreferenceInput!) {
    setUserPreference(input: $input) {
      key
      value
      updatedAt
    }
  }
`;

export const DELETE_USER_PREFERENCE = gql`
  mutation DeleteUserPreference($key: String!) {
    deleteUserPreference(key: $key)
  }
`;

export type GetUserPreferencesQueryResponse = {
  userPreferences: UserPreference[];
};

export type SetUserPreferenceMutationVariables = {
  input: SetUserPreferenceInput;
};

export type SetUserPreferenceMutationResponse = {
  setUserPreference: UserPreference;
};

export type DeleteUserPreferenceMutationVariables = {
  key: string;
};

export type DeleteUserPreferenceMutationResponse = {
  deleteUserPreference: boolean;
};

export type { SetUserPreferenceInput, UserPreference } from '@boardsesh/shared-schema';
