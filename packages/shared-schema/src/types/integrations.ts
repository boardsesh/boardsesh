// External platform integration types (Strava today; Garmin etc. later).
// Device-local integrations (Apple Health) are managed on-device and never
// appear here.

export type IntegrationProvider = 'STRAVA';

export type IntegrationCredentialHealth = 'active' | 'expired' | 'error' | 'revoked';

export type IntegrationStatus = {
  provider: IntegrationProvider;
  connected: boolean;
  externalAccountName?: string | null;
  autoSyncEnabled: boolean;
  status?: IntegrationCredentialHealth | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
};

export type IntegrationExportResult = {
  provider: IntegrationProvider;
  sessionId: string;
  externalActivityId?: string | null;
  externalActivityUrl?: string | null;
  syncedAt?: string | null;
  error?: string | null;
};
