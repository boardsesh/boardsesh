import { BACKEND_URL } from './env';
import { resolveAppEnvironment } from './app-environment';
import { MOBILE_USER_AGENT } from './mobile-user-agent';
import {
  OTA_UPDATE_STATUS_EVENT,
  OTA_LAUNCH_UPDATE_EVENT,
  type OtaStatusProperties,
  type OtaLaunchUpdateProperties,
} from './ota-telemetry';
import { anonymousOtaStatusProperties, anonymousOtaLaunchProperties } from './anonymous-ota-health-properties';
import { isDevBuild } from './is-dev-build';

let launchId: string | null = null;

/** A memory-only launch report through the proxy that strips IP and HTTP User-Agent. */
async function reportAnonymousHealth(
  event: typeof OTA_UPDATE_STATUS_EVENT | typeof OTA_LAUNCH_UPDATE_EVENT,
  properties: ReturnType<typeof anonymousOtaStatusProperties> | ReturnType<typeof anonymousOtaLaunchProperties>,
): Promise<void> {
  const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (isDevBuild() || !apiKey || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
  launchId ??=
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${BACKEND_URL}/api/posthog/batch/`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: apiKey,
        batch: [
          {
            event,
            distinct_id: `ota-launch:${launchId}`,
            properties: {
              ...properties,
              $process_person_profile: false,
              $geoip_disable: true,
              $raw_user_agent: MOBILE_USER_AGENT,
              environment: resolveAppEnvironment(),
            },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch {
    /* Health reporting cannot hold launch or enter product analytics. */
  } finally {
    clearTimeout(timer);
  }
}

export function reportAnonymousOtaStatus(properties: OtaStatusProperties): Promise<void> {
  return reportAnonymousHealth(OTA_UPDATE_STATUS_EVENT, anonymousOtaStatusProperties(properties));
}

export function reportAnonymousOtaLaunch(properties: OtaLaunchUpdateProperties): Promise<void> {
  return reportAnonymousHealth(OTA_LAUNCH_UPDATE_EVENT, anonymousOtaLaunchProperties(properties));
}
