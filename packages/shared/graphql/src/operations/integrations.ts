import { gql } from 'graphql-request';
import type { IntegrationProvider, IntegrationStatus, IntegrationExportResult } from '@boardsesh/shared-schema';

// ============================================
// External Platform Integrations
// ============================================

const INTEGRATION_STATUS_FIELDS = `
  provider
  connected
  externalAccountName
  autoSyncEnabled
  status
  lastSyncAt
  lastError
`;

export const GET_INTEGRATIONS = gql`
  query GetIntegrations {
    integrations {
      ${INTEGRATION_STATUS_FIELDS}
    }
  }
`;

export type GetIntegrationsResponse = {
  integrations: IntegrationStatus[];
};

export const CREATE_INTEGRATION_OAUTH_HANDOFF = gql`
  mutation CreateIntegrationOAuthHandoff($provider: IntegrationProvider!) {
    createIntegrationOAuthHandoff(provider: $provider)
  }
`;

export type CreateIntegrationOAuthHandoffVariables = {
  provider: IntegrationProvider;
};

export type CreateIntegrationOAuthHandoffResponse = {
  createIntegrationOAuthHandoff: string;
};

export const DISCONNECT_INTEGRATION = gql`
  mutation DisconnectIntegration($provider: IntegrationProvider!) {
    disconnectIntegration(provider: $provider)
  }
`;

export type DisconnectIntegrationVariables = {
  provider: IntegrationProvider;
};

export type DisconnectIntegrationResponse = {
  disconnectIntegration: boolean;
};

export const SET_INTEGRATION_AUTO_SYNC = gql`
  mutation SetIntegrationAutoSync($provider: IntegrationProvider!, $enabled: Boolean!) {
    setIntegrationAutoSync(provider: $provider, enabled: $enabled) {
      ${INTEGRATION_STATUS_FIELDS}
    }
  }
`;

export type SetIntegrationAutoSyncVariables = {
  provider: IntegrationProvider;
  enabled: boolean;
};

export type SetIntegrationAutoSyncResponse = {
  setIntegrationAutoSync: IntegrationStatus;
};

export const SYNC_SESSION_TO_INTEGRATION = gql`
  mutation SyncSessionToIntegration($provider: IntegrationProvider!, $sessionId: ID!) {
    syncSessionToIntegration(provider: $provider, sessionId: $sessionId) {
      provider
      sessionId
      externalActivityId
      externalActivityUrl
      syncedAt
      error
    }
  }
`;

export type SyncSessionToIntegrationVariables = {
  provider: IntegrationProvider;
  sessionId: string;
};

export type SyncSessionToIntegrationResponse = {
  syncSessionToIntegration: IntegrationExportResult;
};
