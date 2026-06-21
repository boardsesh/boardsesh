import { Platform } from 'react-native';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type { IntegrationDefinition, SessionExportContext } from './types';
import { autoSaveToAppleHealth } from './apple-health';

// The integration catalog. Apple Health first (device-local, auto-saves on
// session end); Strava second (platform OAuth, uploads run server-side so there
// is no on-device auto-export hook here).
export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: 'apple-health',
    kind: 'device',
    isSupported: () => Platform.OS === 'ios',
    autoExportOnSessionEnd: async (summary, ctx) => {
      await autoSaveToAppleHealth(summary, ctx);
    },
  },
  {
    id: 'strava',
    kind: 'platform',
    // Strava is a server-side OAuth upload, available on every platform.
    isSupported: () => true,
    // No autoExportOnSessionEnd: the backend performs the upload when auto-sync
    // is enabled server-side. Nothing to run on-device at session end.
  },
];

/** Integrations runnable on the current platform/device. */
export function getSupportedIntegrations(): IntegrationDefinition[] {
  return INTEGRATIONS.filter((integration) => integration.isSupported());
}

/**
 * Fire every supported integration's session-end export, fire-and-forget. Each
 * export is wrapped so a rejection can never surface as an unhandled rejection
 * or block the caller (the session-end navigation must not wait on Apple Health
 * or be derailed by it). Returns void synchronously.
 */
export function runSessionEndExports(summary: SessionSummary, ctx: SessionExportContext): void {
  for (const integration of getSupportedIntegrations()) {
    const exportHook = integration.autoExportOnSessionEnd;
    if (!exportHook) continue;
    void exportHook(summary, ctx).catch((error: unknown) => {
      console.warn(`[integrations] ${integration.id} session-end export failed:`, error);
    });
  }
}
