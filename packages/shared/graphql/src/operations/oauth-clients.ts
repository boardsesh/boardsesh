import { gql } from 'graphql-request';
import type {
  CreateOAuthClientInput,
  OAuthClient,
  OAuthClientCredentials,
  UpdateOAuthClientInput,
} from '@boardsesh/shared-schema';

// ============================================
// Developer console: partner apps a signed-in developer registered
// (docs/integration-platform.md, "Self-service registration").
// ============================================

const OAUTH_CLIENT_FIELDS = `
  clientId
  name
  publisherName
  homepageUrl
  privacyPolicyUrl
  applicationType
  tokenEndpointAuthMethod
  redirectUris
  createdAt
  suspendedAt
  suspensionReason
  maxActiveConnections
  maxNewConnectionsPerDay
  activeConnections
`;

export const GET_MY_OAUTH_CLIENTS = gql`
  query MyOAuthClients {
    myOAuthClients {
      ${OAUTH_CLIENT_FIELDS}
    }
  }
`;

// The secret comes back once, from create and rotate only. Callers keep it in
// component state and never in a query cache, a URL or a log.
export const CREATE_OAUTH_CLIENT = gql`
  mutation CreateOAuthClient($input: CreateOAuthClientInput!) {
    createOAuthClient(input: $input) {
      clientSecret
      client {
        ${OAUTH_CLIENT_FIELDS}
      }
    }
  }
`;

export const UPDATE_OAUTH_CLIENT = gql`
  mutation UpdateOAuthClient($input: UpdateOAuthClientInput!) {
    updateOAuthClient(input: $input) {
      ${OAUTH_CLIENT_FIELDS}
    }
  }
`;

export const ROTATE_OAUTH_CLIENT_SECRET = gql`
  mutation RotateOAuthClientSecret($clientId: ID!) {
    rotateOAuthClientSecret(clientId: $clientId) {
      clientSecret
      client {
        ${OAUTH_CLIENT_FIELDS}
      }
    }
  }
`;

export const DELETE_OAUTH_CLIENT = gql`
  mutation DeleteOAuthClient($clientId: ID!) {
    deleteOAuthClient(clientId: $clientId)
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export type MyOAuthClientsQueryResponse = { myOAuthClients: OAuthClient[] };

export type CreateOAuthClientMutationVariables = { input: CreateOAuthClientInput };
export type CreateOAuthClientMutationResponse = { createOAuthClient: OAuthClientCredentials };

export type UpdateOAuthClientMutationVariables = { input: UpdateOAuthClientInput };
export type UpdateOAuthClientMutationResponse = { updateOAuthClient: OAuthClient };

export type RotateOAuthClientSecretMutationVariables = { clientId: string };
export type RotateOAuthClientSecretMutationResponse = { rotateOAuthClientSecret: OAuthClientCredentials };

export type DeleteOAuthClientMutationVariables = { clientId: string };
export type DeleteOAuthClientMutationResponse = { deleteOAuthClient: boolean };
