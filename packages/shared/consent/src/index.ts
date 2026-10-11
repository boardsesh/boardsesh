export {
  ANALYTICS_CONSENT_CHOICES,
  CONSENT_SOURCES,
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isAnalyticsGranted,
  isConsentRecordOwnedBy,
  isConsentSource,
  isCurrentConsentRecord,
  isSameConsentRecord,
  needsPrompt,
  resolveConsent,
  type AnalyticsConsentChoice,
  type ConsentRecord,
  type ConsentSource,
  type DeviceConsentRecord,
} from './consent-record';
export {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  parseConsentCookieValue,
  serializeConsentCookieValue,
} from './consent-cookie';

export {
  createConsentSyncCoordinator,
  mergeAccountConsent,
  parsePendingConsentDecision,
  type AccountConsentMerge,
  type ConsentSyncInput,
  type PendingConsentDecision,
  type ConsentSyncSnapshot,
  type ConsentSyncOptions,
  type ConsentSyncCoordinator,
} from './consent-sync';
