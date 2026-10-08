import { randomUUID } from 'node:crypto';
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
  // Count DISTINCT `climbUuid`s, not events — one looping client resends the
  // same climb and would otherwise read as a fleet-wide problem. A sustained
  // zero is the signal to turn the check into a rejection (#3942).
  | 'Tick Climb Not In Catalog'
  // The daily first-party DAU/WAU/MAU counts from user_activity_days. Counts
  // only, on one fixed system id. See docs/analytics-consent.md.
  | 'Active Users Snapshot';

/**
 * Backend events are operational telemetry sent under legitimate interest, not
 * product analytics, so they must not identify anyone whatever that person's
 * consent (docs/analytics-consent.md). That is enforced here rather than at each
 * call site:
 *
 * - there is no way to pass a distinct id. Every event gets its own random one
 *   (`backend:<event>:<uuid>`), so PostHog cannot join two events into a person;
 * - an aggregate system event may instead name a fixed `system:` id, which is
 *   not a person either;
 * - every event carries `$process_person_profile: false`, so PostHog creates no
 *   person profile for it;
 * - property names that carry identity (`userId`, `email`, ...) are dropped.
 */
interface CaptureBackendEventOptions {
  properties?: AnalyticsProperties;
  /** A fixed id for an aggregate system event, e.g. `system:active-users`. Never a user id. */
  systemDistinctId?: `system:${string}`;
  /** Overrides the event time, e.g. to date a daily snapshot to the day it counts. */
  timestamp?: Date;
  /**
   * A deterministic event UUID, so a re-sent aggregate (a manual re-run of a
   * daily job) collapses into the first copy in PostHog instead of doubling it.
   */
  uuid?: string;
}

/**
 * Property names that would tie a backend event to a person. Compared
 * lower-cased. Dropped at capture so a call site that copies a payload
 * wholesale can't reintroduce one.
 */
const PERSONAL_PROPERTY_NAMES = new Set([
  'userid',
  'user_id',
  'email',
  'distinct_id',
  '$ip',
  '$user_id',
  'sessionid',
  'session_id',
  'boundsessionid',
  'bound_session_id',
]);

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const POSTHOG_FLUSH_AT = 20;
const POSTHOG_FLUSH_INTERVAL_MS = 10_000;

let posthogClient: PostHog | null = null;
let initAttempted = false;
let missingProjectKeyLogged = false;
let nonProductionEnvironmentLogged = false;
const loggedQueuedEvents = new Set<BackendAnalyticsEvent>();
const loggedDroppedProperties = new Set<string>();

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

function sanitizeProperties(
  eventName: BackendAnalyticsEvent,
  properties: AnalyticsProperties | undefined,
): SanitizedAnalyticsProperties {
  const sanitized: SanitizedAnalyticsProperties = {};
  if (!properties) return sanitized;

  for (const [propertyName, propertyValue] of Object.entries(properties)) {
    if (PERSONAL_PROPERTY_NAMES.has(propertyName.toLowerCase())) {
      const droppedKey = `${eventName}:${propertyName}`;
      if (!loggedDroppedProperties.has(droppedKey)) {
        loggedDroppedProperties.add(droppedKey);
        logger.warn(`[PostHog] Dropped personal property '${propertyName}' from backend event: ${eventName}`);
      }
      continue;
    }
    if (propertyValue !== undefined) {
      sanitized[propertyName] = propertyValue;
    }
  }

  return sanitized;
}

/** `backend:tick-climb-not-in-catalog:<uuid>`: one id per event, never reused. */
function eventScopedDistinctId(eventName: BackendAnalyticsEvent): string {
  const eventSlug = eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `backend:${eventSlug}:${randomUUID()}`;
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

export function captureBackendEvent(
  eventName: BackendAnalyticsEvent,
  options: CaptureBackendEventOptions = {},
): boolean {
  const posthog = getPosthogClient();
  if (!posthog) return false;

  const properties = sanitizeProperties(eventName, options.properties);
  properties.service = 'boardsesh-backend';
  properties.environment = getAnalyticsEnvironment();
  properties.$process_person_profile = false;

  try {
    posthog.capture({
      distinctId: options.systemDistinctId ?? eventScopedDistinctId(eventName),
      event: eventName,
      properties,
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.uuid ? { uuid: options.uuid } : {}),
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
  loggedDroppedProperties.clear();

  try {
    await posthog.shutdown();
  } catch (error) {
    logger.warn('[PostHog] Shutdown failed:', error);
  }
}
