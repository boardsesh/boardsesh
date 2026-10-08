export {
  ANALYTICS_CONSENT_CHOICES,
  CONSENT_SOURCES,
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isAnalyticsGranted,
  isConsentSource,
  isCurrentConsentRecord,
  needsPrompt,
  resolveConsent,
  type AnalyticsConsentChoice,
  type ConsentRecord,
  type ConsentSource,
} from './consent-record';
export {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  parseConsentCookieValue,
  serializeConsentCookieValue,
} from './consent-cookie';

export {
  createConsentSyncCoordinator,
  parsePendingConsentDecision,
  type ConsentSyncInput,
  type PendingConsentDecision,
  type ConsentSyncSnapshot,
  type ConsentSyncOptions,
  type ConsentSyncCoordinator,
} from './consent-sync';
