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
  | 'Live Activity Widget Navigation Attribution Gap';

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

function getAnalyticsEnvironment(): string {
  return (
    readOptionalEnv('POSTHOG_ENVIRONMENT') ??
    readOptionalEnv('SENTRY_ENVIRONMENT') ??
    readOptionalEnv('NODE_ENV') ??
    'development'
  );
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
  loggedQueuedEvents.clear();

  try {
    await posthog.shutdown();
  } catch (error) {
    logger.warn('[PostHog] Shutdown failed:', error);
  }
}
