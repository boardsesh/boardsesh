import { resolveSentryEnvironment } from '@boardsesh/db/client/config';
import { PostHog } from 'posthog-node';
import { logger } from '../../utils/logger';

type AnalyticsPropertyValue = string | number | boolean | null | undefined;
type AnalyticsProperties = Record<string, AnalyticsPropertyValue>;
type SanitizedAnalyticsProperties = Record<string, string | number | boolean | null>;
export type BackendAnalyticsEvent =
  | 'Live Activity Ended'
  | 'Live Activity Ended Attribution Gap'
  | 'Live Activity Push Delivery'
  | 'Live Activity Push Delivery Attribution Gap'
  | 'Live Activity Started'
  | 'Live Activity Widget Navigation'
  | 'Live Activity Widget Navigation Attribution Gap'
  // Counter behind the log-only climb-existence check in saveTick (#3528).
  // Count DISTINCT USERS, not events — one looping client would otherwise read
  // as a fleet-wide problem. A sustained zero is the signal to turn the check
  // into a rejection (#3942).
  | 'Tick Climb Not In Catalog'
  // Fires when saveTick or updateTick moved a MoonBoard tick to the angle its
  // climb is actually graded at (#3529). Same counting discipline as the line
  // above: count DISTINCT USERS. A sustained hit rate means a client surface is
  // sending the wrong angle and wants fixing too; a decline to zero is the
  // evidence that the snap could be retired. Retiring it is a deliberate code
  // change either way — #3851's angle-agnostic import does not do it on its own,
  // since it only nulls board_climbs.angle on rows it inserts.
  | 'MoonBoard Tick Angle Snapped'
  // Fires from the Stripe webhook once a build-pack payment is confirmed —
  // never from the browser. The purchase is a server fact, and a client-side
  // "Checkout Started" is not one: it fires whether or not the card clears,
  // and an ad blocker eats it either way. Stratify revenue by `tier` and
  // `board_name`; the two tiers are 5x apart in price, so pooling them makes
  // the average meaningless.
  // `amount_cents` is GST-inclusive — it is `session.amount_total`, i.e. what
  // Stripe actually charged, not the catalogue's pre-tax display price.
  // `amount_excluding_tax_cents` is the GST-exclusive equivalent, derived from
  // `session.total_details.amount_tax` when Stripe reported a tax breakdown
  // (null otherwise); use it rather than deriving a pre-tax figure from
  // `amount_cents` with a guessed rate.
  | 'Build Plans Pack Purchased'
  // Fires from the authenticated download route, once per successful stream.
  // Counts EVENTS, not distinct users, on purpose: a buyer re-downloading their
  // own pack is the signal (a pack that is fetched twenty times is a pack
  // someone is having trouble with, or sharing).
  | 'Build Plans Pack Downloaded';

interface CaptureBackendEventOptions {
  distinctId: string;
  properties?: AnalyticsProperties;
  processPersonProfile?: boolean;
}

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const POSTHOG_FLUSH_AT = 20;
const POSTHOG_FLUSH_INTERVAL_MS = 10_000;

let posthogClient: PostHog | null = null;
let initAttempted = false;
let missingProjectKeyLogged = false;
let nonProductionEnvironmentLogged = false;
const loggedQueuedEvents = new Set<BackendAnalyticsEvent>();

function readOptionalEnv(envName: string): string | null {
  const rawValue = process.env[envName];
  if (!rawValue) return null;

  const trimmedValue = rawValue.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function getProjectKeyConfig(): {
  projectKey: string;
  envName: 'POSTHOG_PROJECT_KEY' | 'NEXT_PUBLIC_POSTHOG_KEY';
} | null {
  const backendProjectKey = readOptionalEnv('POSTHOG_PROJECT_KEY');
  if (backendProjectKey) return { projectKey: backendProjectKey, envName: 'POSTHOG_PROJECT_KEY' };

  const publicProjectKey = readOptionalEnv('NEXT_PUBLIC_POSTHOG_KEY');
  if (publicProjectKey) return { projectKey: publicProjectKey, envName: 'NEXT_PUBLIC_POSTHOG_KEY' };

  return null;
}

function sanitizeProperties(properties: AnalyticsProperties | undefined): SanitizedAnalyticsProperties {
  const sanitized: SanitizedAnalyticsProperties = {};
  if (!properties) return sanitized;

  for (const [propertyName, propertyValue] of Object.entries(properties)) {
    if (propertyValue !== undefined) {
      sanitized[propertyName] = propertyValue;
    }
  }

  return sanitized;
}

function getPosthogClient(): PostHog | null {
  if (posthogClient) return posthogClient;

  const projectKeyConfig = getProjectKeyConfig();
  if (!projectKeyConfig) {
    if (!missingProjectKeyLogged) {
      missingProjectKeyLogged = true;
      logger.warn('[PostHog] POSTHOG_PROJECT_KEY/NEXT_PUBLIC_POSTHOG_KEY is not set; backend analytics disabled');
    }
    return null;
  }
  // Only production sends. Without this, a key present in ANY non-prod runtime —
  // a Railway "shared variable" wired to a future staging service, or a local
  // .env with a real key — would silently pollute the prod project (#3814), the
  // same class of bug #3808 fixed for Sentry. Until now this was safe only
  // because branch-deploy.yml's preview containers never set a PostHog key: an
  // absence-of-key accident, not a gate. Checked before initAttempted (like the
  // missing-key branch above) so one early call can't cache the decision.
  const resolvedEnvironment = getAnalyticsEnvironment();
  if (resolvedEnvironment !== 'production') {
    if (!nonProductionEnvironmentLogged) {
      nonProductionEnvironmentLogged = true;
      // warn, not info, to match the missing-key branch above: both mean
      // "analytics is now dark", and in prod this line is the only signal that
      // a misconfigured environment has switched it off.
      logger.warn(
        `[PostHog] Resolved environment '${resolvedEnvironment}' is not production; backend analytics disabled`,
      );
    }
    return null;
  }
  if (initAttempted) return null;
  initAttempted = true;

  const host = readOptionalEnv('POSTHOG_HOST') ?? DEFAULT_POSTHOG_HOST;
  if (projectKeyConfig.envName === 'NEXT_PUBLIC_POSTHOG_KEY') {
    logger.warn('[PostHog] Using NEXT_PUBLIC_POSTHOG_KEY for backend analytics; prefer POSTHOG_PROJECT_KEY');
  }

  const client = new PostHog(projectKeyConfig.projectKey, {
    host,
    flushAt: POSTHOG_FLUSH_AT,
    flushInterval: POSTHOG_FLUSH_INTERVAL_MS,
    disableGeoip: true,
  });

  client.on('error', (error) => {
    logger.warn('[PostHog] SDK error:', error);
  });

  posthogClient = client;
  logger.info(`[PostHog] Backend analytics initialized (host=${host}, environment=${getAnalyticsEnvironment()})`);
  return client;
}

// POSTHOG_ENVIRONMENT is a deliberate override that lets PostHog's environment
// diverge from Sentry's (e.g. testing PostHog's tagging in isolation) — keep it.
// Everything below it delegates to @boardsesh/db/client/config's
// resolveSentryEnvironment(), the repo's single answer to "what runtime is this
// backend process in": SENTRY_ENVIRONMENT, else 'production' for any non-dev,
// non-test runtime, else NODE_ENV.
//
// The delegation is the point. This used to end in a bare `?? 'development'`,
// which reintroduced the NODE_ENV assumption that issues #3183 and #3603 were
// both filed to remove: Railway prod runs Dockerfile.backend, which never sets
// NODE_ENV, and Railway injects none for a prebuilt-image deploy. (Confirmed
// live: yoga.ts serves GraphiQL only when NODE_ENV !== 'production', and
// https://ws.boardsesh.com/graphql returns the GraphiQL shell.) Under the old
// chain, prod resolved to 'production' *only* via a dashboard-managed variable,
// so the send gate in getPosthogClient() would have gone dark — silently, and
// for 100% of backend analytics — the first time anyone tidied that variable
// away. Sentry doesn't have that failure mode; now neither does this.
// Preview/staging still opt out for free: branch-deploy.yml declares
// SENTRY_ENVIRONMENT=preview (#3808), which wins over the runtime inference.
function getAnalyticsEnvironment(): string {
  return readOptionalEnv('POSTHOG_ENVIRONMENT') ?? resolveSentryEnvironment();
}

export function captureBackendEvent(eventName: BackendAnalyticsEvent, options: CaptureBackendEventOptions): boolean {
  const posthog = getPosthogClient();
  if (!posthog) return false;

  const properties = sanitizeProperties(options.properties);
  properties.service = 'boardsesh-backend';
  properties.environment = getAnalyticsEnvironment();
  if (options.processPersonProfile === false) {
    properties.$process_person_profile = false;
  }

  try {
    posthog.capture({
      distinctId: options.distinctId,
      event: eventName,
      properties,
    });
    if (!loggedQueuedEvents.has(eventName)) {
      loggedQueuedEvents.add(eventName);
      logger.info(`[PostHog] Queued backend analytics event: ${eventName}`);
    }
    return true;
  } catch (error) {
    logger.warn('[PostHog] Capture failed:', error);
    return false;
  }
}

export async function shutdownPosthog(): Promise<void> {
  const posthog = posthogClient;
  if (!posthog) return;

  posthogClient = null;
  initAttempted = false;
  missingProjectKeyLogged = false;
  nonProductionEnvironmentLogged = false;
  loggedQueuedEvents.clear();

  try {
    await posthog.shutdown();
  } catch (error) {
    logger.warn('[PostHog] Shutdown failed:', error);
  }
}
