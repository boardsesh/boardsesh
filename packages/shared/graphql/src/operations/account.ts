import { gql } from 'graphql-request';
import type { DeleteAccountInfo, DeleteAccountInput, UpdateProfileInput } from '@boardsesh/shared-schema';

/**
 * Wire shape of the own-profile selection below. Spelled out rather than
 * reusing the `UserProfile` domain type because GraphQL hands back `null` for
 * absent optional fields, not `undefined`.
 */
export type MyProfile = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  instagramUrl: string | null;
  hasPassword: boolean;
  linkedProviders: string[];
  isTester: boolean;
  createdAt: string;
  favoriteCount: number;
};

// The signed-in user's own profile — the settings form's read side. `email` is
// only ever exposed here (own profile), never on the public `publicProfile`
// query.
export const GET_MY_PROFILE = gql`
  query GetMyProfile {
    profile {
      id
      email
      displayName
      avatarUrl
      instagramUrl
      hasPassword
      linkedProviders
      isTester
      createdAt
      favoriteCount
    }
  }
`;

export type GetMyProfileQueryResponse = {
  profile: MyProfile | null;
};

export const UPDATE_MY_PROFILE = gql`
  mutation UpdateMyProfile($input: UpdateProfileInput!) {
    updateProfile(input: $input) {
      id
      email
      displayName
      avatarUrl
      instagramUrl
      hasPassword
      linkedProviders
      isTester
      createdAt
      favoriteCount
    }
  }
`;

export type UpdateMyProfileMutationVariables = {
  input: UpdateProfileInput;
};

export type UpdateMyProfileMutationResponse = {
  updateProfile: MyProfile;
};

export const GET_DELETE_ACCOUNT_INFO = gql`
  query GetDeleteAccountInfo {
    deleteAccountInfo {
      publishedClimbCount
    }
  }
`;

export type GetDeleteAccountInfoQueryResponse = {
  deleteAccountInfo: Pick<DeleteAccountInfo, 'publishedClimbCount'>;
};

export const DELETE_ACCOUNT = gql`
  mutation DeleteAccount($input: DeleteAccountInput!) {
    deleteAccount(input: $input)
  }
`;

export type DeleteAccountMutationVariables = {
  input: DeleteAccountInput;
};

export type DeleteAccountMutationResponse = {
  deleteAccount: boolean;
};
