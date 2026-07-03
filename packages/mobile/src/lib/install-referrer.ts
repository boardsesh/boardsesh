import { installReferrerNative, type NativeInstallReferrerResult } from '../../modules/install-referrer/src/index';
import { setPersonProperties, track } from './analytics';
import { reportError } from './error-reporting';
import { getPreference, setPreference } from './preference-store';

// Android-only: Play Install Referrer is a Play Store mechanism with no iOS
// equivalent in this PR (an iOS equivalent — SKAdNetwork / Apple Search Ads
// attribution — is out of scope, see boardsesh#3402). InstallReferrerTracker
// gates the call site on Platform.OS so this module is never invoked on iOS.
// Mobile-only (web has no Play Store install), so the event name stays a
// free-string constant rather than an entry in @boardsesh/analytics'
// SHARED_EVENTS (which is for names fired by BOTH platforms) — same
// convention as OTA_UPDATE_STATUS_EVENT in ota-telemetry.ts.
export const INSTALL_ATTRIBUTED_EVENT = 'Install Attributed';

const INSTALL_REFERRER_FETCHED_KEY = 'installReferrerFetched';

// In-memory guard against a concurrent overlapping call — e.g. if the mount
// effect that drives this ever re-fires (remount, fast refresh) before the
// first call's async preference read resolves. Without it, two concurrent
// callers could both observe the persisted flag as unset and both invoke
// fetchNative, doubling the native call and sending duplicate PostHog events.
// The persisted flag alone still does the real "once ever" job across
// launches; this only closes the same-process overlap window.
let fetchInFlight = false;

// Test-only: resets the in-flight guard so each test starts clean, even if a
// prior test's async chain didn't run to its `finally` (e.g. an aborted test).
// Mirrors resetOtaStatusReportedForTests in OtaUpdateTracker.tsx.
export function resetInstallReferrerFetchInFlightForTests(): void {
  fetchInFlight = false;
}

export type ParsedInstallReferrer = {
  raw: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
};

// Pure — unit-testable with a plain string, no native module involved. Parses
// the installReferrer query string for the utm_* params Play forwards
// verbatim when the install came from a tagged Play Store link. Unknown or
// absent params resolve to null; `raw` always preserves the untouched string
// so nothing is lost if a param this parsing doesn't cover shows up later.
export function parseInstallReferrer(raw: string): ParsedInstallReferrer {
  const params = new URLSearchParams(raw);
  return {
    raw,
    source: params.get('utm_source'),
    medium: params.get('utm_medium'),
    campaign: params.get('utm_campaign'),
  };
}

// Fetch-once-ever, cache-the-flag, never-throw. `fetchNative` is injectable so
// tests can supply a fake result without mocking the native module resolver.
export async function maybeFetchAndAttachInstallReferrer(
  fetchNative: () => Promise<NativeInstallReferrerResult | null> = () =>
    installReferrerNative?.getInstallReferrer() ?? Promise.resolve(null),
): Promise<void> {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    const alreadyFetched = await getPreference<boolean>(INSTALL_REFERRER_FETCHED_KEY);
    if (alreadyFetched) return;

    const result = await fetchNative();
    // Mark fetched regardless of a clean outcome (success or a resolved null,
    // e.g. FEATURE_NOT_SUPPORTED on a sideloaded install) — Play's referrer is
    // only reliably available in a short window after install, so retrying on
    // every future launch has little value. A thrown exception below skips
    // this write, so a transient failure (e.g. SERVICE_UNAVAILABLE) does retry
    // on the next launch.
    await setPreference(INSTALL_REFERRER_FETCHED_KEY, true);
    if (!result) return;

    const parsed = parseInstallReferrer(result.installReferrer);
    // Person properties are written even for an organic/direct install (all
    // three utm_* fields null) — that's honest, useful data for channel-mix
    // cohorting. But INSTALL_ATTRIBUTED_EVENT specifically means "we resolved
    // a campaign for this install", so only fire it when at least one utm_*
    // field is present — an unconditional fire here would name every organic
    // install "attributed" and inflate attributed-install counts.
    setPersonProperties(undefined, {
      install_referrer_raw: parsed.raw,
      install_source: parsed.source,
      install_medium: parsed.medium,
      install_campaign: parsed.campaign,
      install_click_timestamp: result.referrerClickTimestampSeconds,
      install_begin_timestamp: result.installBeginTimestampSeconds,
    });
    const hasAttribution = parsed.source !== null || parsed.medium !== null || parsed.campaign !== null;
    if (hasAttribution) {
      track(INSTALL_ATTRIBUTED_EVENT, {
        install_source: parsed.source,
        install_medium: parsed.medium,
        install_campaign: parsed.campaign,
      });
    }
  } catch (error) {
    // Must never throw — this runs fire-and-forget at startup. Still reported
    // so a broken preference store / PostHog init doesn't fail this pipeline
    // invisibly.
    reportError(error);
  } finally {
    fetchInFlight = false;
  }
}
