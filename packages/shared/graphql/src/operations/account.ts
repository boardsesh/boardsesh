import { gql } from 'graphql-request';
import type { DeleteAccountInfo, DeleteAccountInput } from '@boardsesh/shared-schema';

export const GET_AUTHENTICATED_USER_ID = gql`
  query GetAuthenticatedUserId {
    authenticatedUserId
  }
`;

export type GetAuthenticatedUserIdQueryResponse = {
  authenticatedUserId: string;
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
