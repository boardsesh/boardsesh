import { browserSessionGuard } from './auth/session-guard';
import { getWebConsentRecord, hasAnalyticsConsent } from './consent';
import { isAdminAnalyticsUrl, isProductAnalyticsFreeUrl } from './analytics-paths';
import { searchCarriesBoardInvite } from './board-invite';

type CaptureModule = Pick<typeof import('./analytics'), 'track' | 'trackBeforeNavigation'>;
type EventProperties = Parameters<CaptureModule['track']>[1];

const NAVIGATION_BUDGET_MS = 250;
// Bound retained event payloads even when a chunk request never settles.
const MAX_COLD_CAPTURES = 16;
let pendingImports = 0;
let analytics: CaptureModule | undefined;

function eventLocation(): string {
  const location = new URL(window.location.href);
  // The QR landing tracker removes its own attribution pair after hydration.
  location.searchParams.delete('src');
  location.searchParams.delete('medium');
  return location.href;
}

async function capture(
  method: keyof CaptureModule,
  name: string,
  properties: EventProperties,
  expiresAt = Infinity,
): Promise<void> {
  if (
    typeof window === 'undefined' ||
    !hasAnalyticsConsent() ||
    isAdminAnalyticsUrl(window.location.pathname) ||
    isProductAnalyticsFreeUrl(window.location.pathname) ||
    searchCarriesBoardInvite(window.location.search)
  )
    return;
  const guard = browserSessionGuard();
  const generation = guard.capture();
  if (guard.viewerKey() === undefined || !guard.isCurrent(generation)) return;

  if (!analytics) {
    if (pendingImports >= MAX_COLD_CAPTURES) return;
    const consentAtEvent = getWebConsentRecord();
    const locationAtEvent = eventLocation();
    pendingImports++;
    try {
      analytics = await import('./analytics');
    } finally {
      pendingImports--;
    }
    // A withdrawal followed by a new Allow also invalidates the original event.
    if (
      performance.now() >= expiresAt ||
      eventLocation() !== locationAtEvent ||
      !guard.isCurrent(generation) ||
      !hasAnalyticsConsent() ||
      getWebConsentRecord() !== consentAtEvent
    )
      return;
  }
  await analytics[method](name, properties);
}

export function track(name: string, properties?: EventProperties): void {
  void capture('track', name, properties).catch(() => {});
}

export async function trackBeforeNavigation(name: string, properties?: EventProperties): Promise<void> {
  const expiresAt = performance.now() + NAVIGATION_BUDGET_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, NAVIGATION_BUDGET_MS);
  });
  try {
    await Promise.race([budget, capture('trackBeforeNavigation', name, properties, expiresAt)]);
  } catch {
    // An unavailable capture module or transport must release the navigating click.
  } finally {
    clearTimeout(timeout);
  }
}
