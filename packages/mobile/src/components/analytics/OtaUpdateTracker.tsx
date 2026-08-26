import { useEffect, useRef } from 'react';
import * as Updates from 'expo-updates';
import { registerSuperProperties, track } from '../../lib/analytics';
import {
  OTA_UPDATE_DOWNLOADED_EVENT,
  OTA_UPDATE_STATUS_EVENT,
  buildOtaStatusProperties,
  readOtaBranch,
} from '../../lib/ota-telemetry';
import { setOtaSentryTags } from '../../lib/sentry';

// Emits OTA-adoption telemetry so a JS-only rollout is measurable (we previously
// had no way to tell how many installs pulled an OTA — issue #3098). On mount it
// reports the running bundle once and stamps the OTA cohort onto every later
// event as super properties; while mounted it reports a freshly-downloaded
// bundle (the "fetched, applies next launch" step of the funnel). Renders
// nothing — mounted once near the app root beside AnalyticsScreenTracker. See
// docs/mobile-ota-updates.md.

// Module-scoped so the launch status fires at most once per JS runtime (= once
// per launch) even if this subtree is ever torn down and recreated. The tracker
// lives at the root layout and won't remount in practice, but this makes the
// "once per launch" intent hold regardless. An OTA reload restarts the runtime,
// clearing this, so the next launch re-reports the new bundle.
let hasReportedStatus = false;

// Test-only: resets the once-per-launch guard so each render starts clean.
export function resetOtaStatusReportedForTests(): void {
  hasReportedStatus = false;
}

// Stamp the OTA cohort onto Sentry as global tags. Exported so a test can assert
// the Updates.* → tag-field wiring; CALLED at module-eval time below (not in an
// effect) so it runs when the root layout imports this tracker — after
// Sentry.init (imported first) but before the provider tree and the auth gate
// render. A native crash / app hang / startup reportError during splash or auth
// then still carries ota_channel + the bundle identifiers — the window an
// effect-based stamp would miss. expo-updates' constants are available
// synchronously at import; setOtaSentryTags no-ops when Sentry is disabled.
export function stampOtaLaunchSentryTags(): void {
  setOtaSentryTags({
    channel: Updates.channel,
    branch: readOtaBranch(Updates.manifest),
    updateId: Updates.updateId,
    runtimeVersion: Updates.runtimeVersion,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  });
}

stampOtaLaunchSentryTags();

export function OtaUpdateTracker(): null {
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();
  const reportedDownloadIdRef = useRef<string | null>(null);

  // Report the running bundle once. track() no-ops when analytics is disabled
  // (dev / no key) but still logs via its __DEV__ debug hook, so this is
  // observable in Metro without sending anything. updateId / runtimeVersion come
  // from the imperative Updates.* constants because useUpdates()' currentlyRunning
  // omits runtimeVersion.
  useEffect(() => {
    if (hasReportedStatus) return;
    hasReportedStatus = true;
    const properties = buildOtaStatusProperties({
      isEnabled: Updates.isEnabled,
      isEmbeddedLaunch: Updates.isEmbeddedLaunch,
      updateId: Updates.updateId,
      channel: Updates.channel,
      branch: readOtaBranch(Updates.manifest),
      runtimeVersion: Updates.runtimeVersion,
      createdAt: Updates.createdAt,
      isEmergencyLaunch: Updates.isEmergencyLaunch,
      emergencyLaunchReason: Updates.emergencyLaunchReason,
    });
    track(OTA_UPDATE_STATUS_EVENT, properties);
    registerSuperProperties({
      ota_update_id: properties.updateId,
      ota_is_embedded: properties.isEmbeddedLaunch,
      ota_runtime_version: properties.runtimeVersion,
      // Was previously stamped only on this one-off event, not as a super
      // property, so pr-* preview traffic had no way to be identified on any
      // OTHER event (#3814) — the environment super property (registerAppEnvironment,
      // posthog-client.ts) covers prod-vs-preview; this covers WHICH preview.
      // Registered here rather than at client construction, so events fired
      // before this effect runs carry no ota_channel. Accepted: `environment` has
      // no such window, and prod-vs-preview is the filter that matters.
      ota_channel: properties.channel,
      ota_branch: properties.branch,
    });
  }, []);

  // A newer bundle finished downloading this session; it applies on the next
  // launch (whose OTA Update Status event records the switch to isEmbeddedLaunch
  // false with this updateId). Dedupe on updateId so a repeated pending state
  // doesn't double-count the same download.
  useEffect(() => {
    if (!isUpdatePending || !downloadedUpdate) return;
    const downloadedUpdateId = downloadedUpdate.updateId ?? null;
    if (reportedDownloadIdRef.current === downloadedUpdateId) return;
    reportedDownloadIdRef.current = downloadedUpdateId;
    track(OTA_UPDATE_DOWNLOADED_EVENT, {
      updateId: downloadedUpdateId,
      createdAtIso: downloadedUpdate.createdAt ? downloadedUpdate.createdAt.toISOString() : null,
    });
  }, [isUpdatePending, downloadedUpdate]);

  return null;
}
