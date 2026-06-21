import { PostHog } from 'posthog-react-native';
import { installGlobalErrorCapture } from './global-error-capture';

// PostHog classifies traffic by parsing the request User-Agent into
// `$raw_user_agent` (its `$virt_is_bot` / traffic-type is `isLikelyBot($raw_user_agent)`).
// The RN SDK sends no UA that PostHog stores, so without this every mobile event
// lands with an empty UA — which PostHog treats as a bot, hiding all real mobile
// users behind the "Regular traffic" filter. A non-empty UA with no denylisted
// bot substring ("bot"/"crawler"/…) classifies as Regular. Kept a static
// constant rather than derived from `react-native` Platform so this module stays
// free of the RN Flow barrel (react-native/index.js), which the node-env test
// runner that imports this file transitively can't parse. OS, device, and app
// version already ride on $os / $device_model / $app_version, so the UA only
// needs the non-bot signature; the SDK still sets $os / $device_type directly.
const MOBILE_USER_AGENT = 'Boardsesh Mobile';

// PostHog project token. Intentionally the SAME project as web so a signed-in
// user's web + mobile activity resolves to one person. `EXPO_PUBLIC_*` vars are
// inlined into the JS bundle at build time, so this must be set when the bundle
// (OTA or native) is built, not merely present at runtime.
const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY;
// Native apps have no ad-blocker / first-party-cookie concern, so we talk to
// PostHog cloud directly rather than the backend reverse proxy the web app uses.
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

// Live only in non-dev builds with a key configured. Preview (TestFlight /
// internal) and production builds are both `!__DEV__`, so telemetry flows from
// them; local Metro dev never sends.
export const isAnalyticsEnabled = !!apiKey && !__DEV__;

type ErrorReportContext = {
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};
type PostHogPropertyValue =
  | string
  | number
  | boolean
  | null
  | PostHogPropertyValue[]
  | { [key: string]: PostHogPropertyValue };

let client: PostHog | null = null;
let initAttempted = false;

// Construct or return the single PostHog client. Returns null in dev / when
// unkeyed, which makes every wrapper method a no-op.
export function getPostHogClient(): PostHog | null {
  if (!isAnalyticsEnabled || !apiKey) return null;
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;
  // captureAppLifecycleEvents defaults on (Application Opened/Backgrounded etc.);
  // expo-device + expo-application (installed) enrich events with $device_model,
  // $os_version, $app_version. Screen autocapture is handled in AnalyticsProvider.
  //
  // Known gap: this client is constructed at AnalyticsProvider mount (top of the
  // tree), so the first Application Opened fires under PostHog's auto-generated
  // anonymous distinct_id before PartyProfileProvider has run identify() with
  // the party-profile UUID (and, for signed-in users, the alias to the user).
  // PostHog merges those early events into the person record once the alias is
  // processed, so this is acceptable (web has the same cold-start window), but
  // don't be surprised to see a few lifecycle events on a transient anon id.
  client = new PostHog(apiKey, {
    host,
    errorTracking: {
      autocapture: {
        uncaughtExceptions: true,
        unhandledRejections: true,
        console: [],
      },
    },
    // `enableSessionReplay` defaults false, so the SDK never auto-records.
    // Capture only begins when setSessionRecordingEnabled() calls
    // startSessionRecording(), which lazily initialises the native replay SDK.
    sessionReplayConfig: {
      maskAllTextInputs: true,
      maskAllImages: true,
      captureLog: true,
    },
  });
  // Attach a device User-Agent to every event so PostHog's bot classifier sees
  // real mobile traffic instead of an empty UA. Never let this block init.
  try {
    client.register({ $raw_user_agent: MOBILE_USER_AGENT });
  } catch {
    // Super-property registration is best-effort; analytics must still start.
  }
  installMobileGlobalErrorCapture();
  return client;
}

function toPostHogPropertyValue(
  value: unknown,
  seenObjects: WeakSet<object> = new WeakSet(),
  depth = 0,
): PostHogPropertyValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return value.toISOString();
  if (depth > 8) return '[Truncated]';
  if (Array.isArray(value)) {
    if (seenObjects.has(value)) return '[Circular]';
    seenObjects.add(value);
    const items: PostHogPropertyValue[] = [];
    for (const item of value) {
      const mappedItem = toPostHogPropertyValue(item, seenObjects, depth + 1);
      if (mappedItem !== undefined) items.push(mappedItem);
    }
    seenObjects.delete(value);
    return items;
  }
  if (typeof value === 'object') {
    if (seenObjects.has(value)) return '[Circular]';
    seenObjects.add(value);
    const properties: { [key: string]: PostHogPropertyValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const mappedItem = toPostHogPropertyValue(item, seenObjects, depth + 1);
      if (mappedItem !== undefined) properties[key] = mappedItem;
    }
    seenObjects.delete(value);
    return properties;
  }
  return undefined;
}

function buildErrorProperties(context?: ErrorReportContext): Record<string, PostHogPropertyValue> {
  const properties: Record<string, PostHogPropertyValue> = {};
  if (!context) return properties;
  if (context.level) properties.$exception_level = context.level;

  for (const [key, value] of Object.entries(context.tags ?? {})) {
    const mappedValue = toPostHogPropertyValue(value);
    if (mappedValue !== undefined) properties[key] = mappedValue;
  }
  for (const [key, value] of Object.entries(context.extra ?? {})) {
    const mappedValue = toPostHogPropertyValue(value);
    if (mappedValue !== undefined) properties[key] = mappedValue;
  }

  return properties;
}

function installMobileGlobalErrorCapture(): void {
  installGlobalErrorCapture({
    report: (error, context) => captureError(error, context),
    flush: () => flushPostHog(),
    isDev: __DEV__,
  });
}

export function captureError(error: unknown, context?: ErrorReportContext): void {
  const posthog = getPostHogClient();
  if (!posthog) return;
  try {
    posthog.captureException(error, buildErrorProperties(context));
  } catch {
    // Error reporting must never become the crash.
  }
}

export function flushPostHog(): Promise<unknown> {
  const posthog = getPostHogClient();
  return posthog ? posthog.flush() : Promise.resolve(true);
}

if (isAnalyticsEnabled) {
  getPostHogClient();
} else {
  installMobileGlobalErrorCapture();
}
