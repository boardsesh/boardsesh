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
import { getPersistentAnonymousInstallId } from './anonymous-install-id';

/**
 * An anonymous launch report through the proxy that strips IP and HTTP
 * User-Agent. The distinct id is the install's random id
 * (anonymous-install-id.ts), so adoption and emergency rates count installs,
 * not launches. No person profile, no GeoIP, no account id.
 */
async function reportAnonymousHealth(
  event: typeof OTA_UPDATE_STATUS_EVENT | typeof OTA_LAUNCH_UPDATE_EVENT,
  properties: ReturnType<typeof anonymousOtaStatusProperties> | ReturnType<typeof anonymousOtaLaunchProperties>,
): Promise<void> {
  const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (isDevBuild() || !apiKey || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return;
  const installId = await getPersistentAnonymousInstallId();
  // Missing secure randomness or persistence: a launch-only fallback would
  // inflate install adoption, so skip this health report.
  if (!installId) return;
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
            distinct_id: `ota-install:${installId}`,
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
