import { PostHog, PostHogPersistedProperty, type PostHogOptions } from 'posthog-react-native';
import { resolveAnalyticsUserAgent } from './analytics-user-agent';
import { resolveAppEnvironment } from './app-environment';
import {
  getConsentSnapshot,
  isProductAnalyticsGranted,
  isConsentAuthorityGranted,
  subscribeConsent,
  updateConsentState,
} from './consent-state';
import { createConsentPosthogStorage } from './consent-posthog-storage';
import { posthogStorageBackend } from './posthog-storage-backend';
import { BACKEND_URL } from './env';
import { isAnalyticsGranted } from '@boardsesh/consent';
import { applySessionReplayConsent } from './session-replay-consent';
import { applyNativeReplayPrivacy } from './replay-privacy';
import { isDevBuild } from './is-dev-build';

// Registers the User-Agent as a super property on every event: the static,
// non-bot app constant on native, the real browser UA in the Expo browser app
// (see analytics-user-agent.web.ts), and nothing at all when that browser has
// no UA, so PostHog flags the event as it does on www. Exported so the call site is unit-testable:
// getPostHogClient() returns null before reaching its own call to this whenever
// analytics is disabled (no token, or __DEV__ — both hold in the test env), so
// the live path can't run in tests. Best-effort: a failure must never block
// analytics init.
export function registerMobileUserAgent(client: Pick<PostHog, 'register'>): void {
  const userAgent = resolveAnalyticsUserAgent();
  if (!userAgent) return;
  try {
    void Promise.resolve(client.register({ $raw_user_agent: userAgent })).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register $raw_user_agent super property', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register $raw_user_agent super property', error);
  }
}

// Registers the resolved app environment ('production' / 'preview', shared with
// Sentry — see app-environment.ts) as a super property on every event. Without
// this, mobile PostHog events carried no environment tag at all — `pr-*` OTA
// preview traffic was indistinguishable from real production usage in every
// event except the once-per-launch `OTA Update Status` event (#3814). Exported
// like registerMobileUserAgent so the call site is unit-testable; same
// best-effort contract (a failure here must never block analytics init).
export function registerAppEnvironment(client: Pick<PostHog, 'register'>): void {
  try {
    void Promise.resolve(client.register({ environment: resolveAppEnvironment() })).catch((error: unknown) => {
      if (__DEV__) console.warn('[analytics] failed to register environment super property', error);
    });
  } catch (error) {
    if (__DEV__) console.warn('[analytics] failed to register environment super property', error);
  }
}

// The super properties that describe the app build rather than the person, so
// they belong on every event no matter who is signed in. Registered at client
// construction AND re-registered after analytics.reset(): PostHog's reset()
// clears every registered super property, and getPostHogClient() caches the
// singleton, so without a re-register a logout / forced sign-out / account
// switch drops them for the rest of the launch — `environment` (preview traffic
// would look like production again, reopening #3814) and `$raw_user_agent`
// (PostHog bot-filters events that have no UA).
export function registerAppSuperProperties(client: Pick<PostHog, 'register'>): void {
  registerMobileUserAgent(client);
  registerAppEnvironment(client);
}

// PostHog project token. Intentionally the SAME project as web so a signed-in
// user's web + mobile activity resolves to one person. `EXPO_PUBLIC_*` vars are
// inlined into the JS bundle at build time, so this must be set when the bundle
// (OTA or native) is built, not merely present at runtime.
const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
// The first-party proxy strips network identity headers for both native and web.
const host = `${BACKEND_URL}/api/posthog`;
const captureRequests = new Set<AbortController>();
let flagAccountId: string | null = null;
let initializingIdentity = false;
const flagLaunchId = `flags-launch:${Date.now()}:${Math.random().toString(36).slice(2)}`;

subscribeConsent(() => {
  if (isProductAnalyticsGranted()) return;
  for (const request of captureRequests) request.abort();
  captureRequests.clear();
});

export class ConsentPostHog extends PostHog {
  override async fetch(url: string, options: Parameters<PostHog['fetch']>[1]): ReturnType<PostHog['fetch']> {
    const operational = /\/flags\//.test(url) || /\/array\/[^/]+\/config\/?(?:\?|$)/.test(url);
    if (operational) {
      // Flags can target an account without changing the product identity that
      // the later anonymous-to-account identify event must reconcile.
      if (/\/flags\//.test(url) && typeof options.body === 'string') {
        const payload: unknown = JSON.parse(options.body);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const granted = isProductAnalyticsGranted();
          const account = getConsentSnapshot();
          const flagsIdentity = account.authSettled && account.accountId === flagAccountId ? flagAccountId : null;
          options = {
            ...options,
            body: JSON.stringify({
              ...payload,
              distinct_id: granted
                ? 'distinct_id' in payload
                  ? payload.distinct_id
                  : (flagsIdentity ?? flagLaunchId)
                : (flagsIdentity ?? flagLaunchId),
              ...(!granted
                ? {
                    $device_id: undefined,
                    $anon_distinct_id: undefined,
                    person_properties: {},
                    group_properties: {},
                    groups: {},
                  }
                : {}),
            }),
          };
        }
      }
      return super.fetch(url, { ...options, credentials: 'omit' });
    }
    if (!isProductAnalyticsGranted()) return { status: 200, text: async () => '', json: async () => ({}) };
    const controller = new AbortController();
    const epoch = getConsentSnapshot().authEpoch;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    captureRequests.add(controller);
    try {
      if (!isProductAnalyticsGranted() || epoch !== getConsentSnapshot().authEpoch) controller.abort();
      return await super.fetch(url, { ...options, credentials: 'omit', signal: controller.signal });
    } finally {
      captureRequests.delete(controller);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

// Live only in non-dev builds with a key configured. Preview (TestFlight /
// internal) and production builds are both `!__DEV__`, so telemetry flows from
// them; local Metro dev never sends.
export const isAnalyticsEnabled = !!apiKey && !isDevBuild() && process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1';

let client: PostHog | null = null;
let initAttempted = false;
let persistence: ReturnType<typeof createConsentPosthogStorage> | null = null;
const initializedListeners = new Set<() => void>();

export function subscribePosthogInitialized(listener: () => void): () => void {
  initializedListeners.add(listener);
  return () => initializedListeners.delete(listener);
}

/** Flags may target signed-in accounts without emitting an identify event or writing device storage. */
export function setPosthogFlagIdentity(accountId: string | null): void {
  flagAccountId = accountId;
  client?.reloadFeatureFlags();
}

// Pure so the options are unit-testable without constructing a real PostHog
// client (isAnalyticsEnabled is always false in the test env).
//
// There is no `bootstrap` on purpose. The SDK mints and persists its own
// anonymous id, and that id is the only anonymous identity the app has: see the
// header of packages/shared/analytics/src/reconcile-identity.ts. The option
// used to carry the party-profile UUID, but the slot it read was still empty
// when this module was evaluated (expo-router loads `app/(tabs)/_layout.tsx`,
// which reaches this file, before the root layout that filled the slot), so it
// never took effect on a device.
export function buildPostHogOptions(postHogHost: string): PostHogOptions {
  return {
    host: postHogHost,
    defaultOptIn: false,
    persistence: 'file',
    capturePushNotificationOpened: false,
    capturePushNotificationSubscriptions: false,
    disableSurveys: true,
    before_send: (event) =>
      isProductAnalyticsGranted() ||
      (initializingIdentity && event?.event === '$identify' && isConsentAuthorityGranted())
        ? event
        : null,
    // Every event builds a person, signed out included. The SDK default,
    // `identified_only`, sends signed-out events personless until something
    // identifies or sets a person property. The app never ran that way: its old
    // signed-out identify() switched person processing on at every launch. That
    // call is gone (reconcile-identity.ts, rule 2), so this keeps what it did for
    // person counts and `person.properties` breakdowns on signed-out traffic.
    // It does not mark anyone identified: an anonymous person made this way
    // still merges into an account on sign-in.
    personProfiles: 'always',
    // The app already emits explicit $screen events plus reviewed product
    // events. SDK lifecycle autocapture adds high-volume foreground/background
    // noise and does not help answer product or BLE reliability questions.
    captureAppLifecycleEvents: false,
    // `enableSessionReplay` defaults false, so the SDK never auto-records.
    // Capture only begins when setSessionRecordingEnabled() calls
    // startSessionRecording(), which lazily initialises the native replay SDK.
    sessionReplayConfig: {
      maskAllTextInputs: true,
      maskAllImages: true,
      captureLog: true,
    },
  };
}

// Construct or return the single PostHog client. Returns null in dev / when
// unkeyed, which makes every wrapper method a no-op. PostHog is product
// analytics only — error/crash reporting goes to Sentry (src/lib/sentry.ts).
export function getPostHogClient(): PostHog | null {
  if (!isAnalyticsEnabled || !apiKey) return null;
  return client;
}

/** Retain consented identity during account resolution, excluding every queued signal. */
export function sanitizeRememberedPosthogFile(payload: string): string | null {
  try {
    const stored: unknown = JSON.parse(payload);
    if (
      !stored ||
      typeof stored !== 'object' ||
      Array.isArray(stored) ||
      !('content' in stored) ||
      !stored.content ||
      typeof stored.content !== 'object' ||
      Array.isArray(stored.content)
    )
      return null;
    return JSON.stringify({
      ...stored,
      content: {
        ...stored.content,
        [PostHogPersistedProperty.OptedOut]: true,
        [PostHogPersistedProperty.Queue]: [],
        [PostHogPersistedProperty.AiQueue]: [],
        [PostHogPersistedProperty.AiCaptureQueue]: [],
        [PostHogPersistedProperty.LogsQueue]: [],
      },
    });
  } catch {
    return null;
  }
}

export async function initializePosthogClient(): Promise<void> {
  if (!getConsentSnapshot().loaded) return;
  if (!isAnalyticsEnabled || !apiKey) {
    updateConsentState({ sdkReady: true });
    return;
  }
  if (initAttempted) return;
  initAttempted = true;
  const granted = isConsentAuthorityGranted();
  const retainedGrant = isAnalyticsGranted(getConsentSnapshot().record);
  const remembered = new Map<string, string>();
  if (retainedGrant && !granted) {
    // Retain a previously consented identity locally during auth resolution.
    // Queues and opt-in are excluded; flags get a separate functional identity.
    const payload = await posthogStorageBackend.getItem('.posthog-rn.json').catch(() => null);
    if (payload) {
      const sanitized = sanitizeRememberedPosthogFile(payload);
      if (sanitized) remembered.set('.posthog-rn.json', sanitized);
    }
  }
  persistence = createConsentPosthogStorage(posthogStorageBackend, granted, remembered);
  if (!retainedGrant) await persistence.setGranted(false);
  await applyNativeReplayPrivacy(granted, apiKey);
  if (!isAnalyticsGranted(getConsentSnapshot().record)) await persistence.setGranted(false);
  client = new ConsentPostHog(apiKey, { ...buildPostHogOptions(host), customStorage: persistence.storage });
  await client.ready();
  await applyPosthogConsent();
  registerAppSuperProperties(client);
  for (const listener of initializedListeners) listener();
}

export function clearPosthogQueues(posthog: PostHog): void {
  for (const key of [
    PostHogPersistedProperty.Queue,
    PostHogPersistedProperty.AiQueue,
    PostHogPersistedProperty.AiCaptureQueue,
    PostHogPersistedProperty.LogsQueue,
  ]) {
    posthog.setPersistedProperty(key, []);
  }
}

export async function applyPosthogConsent(): Promise<void> {
  const granted = isConsentAuthorityGranted();
  const epoch = getConsentSnapshot().authEpoch;
  const nativePrivacy = apiKey ? applyNativeReplayPrivacy(granted, apiKey) : Promise.resolve();
  const retainsGrant = isAnalyticsGranted(getConsentSnapshot().record);
  if (client && !granted) updateConsentState({ sdkReady: false });
  if (!granted && retainsGrant) {
    // Auth and account synchronization suspend capture; they are not a withdrawal.
    persistence?.suspend();
    if (client) {
      void client.optOut();
      void applySessionReplayConsent(client, false);
    }
    return;
  }
  // The storage adapter disables disk writes synchronously before it awaits deletion.
  const storageUpdate = persistence?.setGranted(granted);
  if (client) {
    if (granted) {
      await client.ready();
      if (epoch !== getConsentSnapshot().authEpoch || !isConsentAuthorityGranted()) return;
      const accountId = getConsentSnapshot().accountId;
      const distinctId = client.getDistinctId();
      if (distinctId !== (accountId ?? client.getAnonymousId()) && distinctId !== client.getAnonymousId()) {
        client.reset([]);
        clearPosthogQueues(client);
        registerAppSuperProperties(client);
      }
      await client.optIn();
      await nativePrivacy;
      if (epoch !== getConsentSnapshot().authEpoch || !isConsentAuthorityGranted()) return;
      if (accountId) {
        initializingIdentity = true;
        try {
          client.identify(accountId);
        } finally {
          initializingIdentity = false;
        }
      }
      updateConsentState({ sdkReady: true });
    } else {
      updateConsentState({ sdkReady: false });
      void client.optOut();
      void applySessionReplayConsent(client, false);
      client.reset([]);
      clearPosthogQueues(client);
      void client.optOut();
      registerAppSuperProperties(client);
    }
  }
  await storageUpdate;
}
