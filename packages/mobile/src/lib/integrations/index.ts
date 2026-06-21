// Public API for the external-platform integrations (Apple Health + Strava).
// UI screens import from here; the native bridge and orchestration internals
// stay in the sibling modules.

export type { IntegrationId, IntegrationDefinition, SessionExportContext } from './types';

export { INTEGRATIONS, getSupportedIntegrations, runSessionEndExports } from './registry';

export {
  isAppleHealthAvailable,
  requestAppleHealthAuthorization,
  getAppleHealthAuthorizationStatus,
  type AppleHealthAuthorizationStatus,
  useHealthKitAutoSavePreference,
  useHealthKitSaveState,
  autoSaveToAppleHealth,
  manualSaveToAppleHealth,
  _resetHealthKitSaveStateForTests,
  type HealthKitSaveState,
} from './apple-health';

export { connectStrava, type StravaConnectResult } from './strava';
