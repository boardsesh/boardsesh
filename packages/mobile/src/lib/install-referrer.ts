import { installReferrerNative, type NativeInstallReferrerResult } from '../../modules/install-referrer/src/index';
import { setPersonProperties, track } from './analytics';
import { getPreference, setPreference } from './preference-store';

// Android-only: Play Install Referrer is a Play Store mechanism with no iOS
// equivalent in this PR (an iOS equivalent — SKAdNetwork / Apple Search Ads
// attribution — is out of scope, see boardsesh#3402). InstallReferrerTracker
// gates the call site on Platform.OS so this module is never invoked on iOS.

const INSTALL_REFERRER_FETCHED_KEY = 'installReferrerFetched';

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
    setPersonProperties(undefined, {
      install_referrer_raw: parsed.raw,
      install_source: parsed.source,
      install_medium: parsed.medium,
      install_campaign: parsed.campaign,
      install_click_timestamp: result.referrerClickTimestampSeconds,
      install_begin_timestamp: result.installBeginTimestampSeconds,
    });
    track('Install Attributed', {
      install_source: parsed.source,
      install_medium: parsed.medium,
      install_campaign: parsed.campaign,
    });
  } catch {
    // Must never throw — this runs fire-and-forget at startup.
  }
}
