import { gql } from 'graphql-request';
import type { ConnectedApps } from '@boardsesh/shared-schema';

// ============================================
// Connected apps: apps a climber connected through partner OAuth
// ============================================

export const GET_MY_CONNECTED_APPS = gql`
  query GetMyConnectedApps {
    myConnectedApps {
      apps {
        connectionId
        name
        publisherName
        scopes
        connectedAt
        lastUsedAt
        suspended
      }
      partnerAppsEnabled
    }
  }
`;

export type GetMyConnectedAppsResponse = {
  myConnectedApps: ConnectedApps;
};

export const GET_PARTNER_APPS_ENABLED = gql`
  query GetPartnerAppsEnabled {
    partnerAppsEnabled
  }
`;

export type GetPartnerAppsEnabledResponse = {
  partnerAppsEnabled: boolean;
};

export const DISCONNECT_APP = gql`
  mutation DisconnectApp($connectionId: ID!) {
    disconnectApp(connectionId: $connectionId)
  }
`;

export type DisconnectAppVariables = {
  connectionId: string;
};

export type DisconnectAppResponse = {
  disconnectApp: boolean;
};
