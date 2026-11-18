export {
  AD_MEASUREMENT_COPY_SINCE,
  ANALYTICS_CONSENT_CHOICES,
  CONSENT_BASES,
  CONSENT_SOURCES,
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isAnalyticsGranted,
  isConsentBasis,
  isConsentRecordOwnedBy,
  isConsentSource,
  isCurrentConsentRecord,
  isRegionDefaultConsent,
  isSameConsentRecord,
  needsPrompt,
  resolveConsent,
  type AnalyticsConsentChoice,
  type ConsentBasis,
  type ConsentRecord,
  type ConsentSource,
  type DeviceConsentRecord,
} from './consent-record';
export {
  ANALYTICS_CAPTURE_PATH,
  ANALYTICS_CONSENT_HEADER,
  ANALYTICS_CONSENT_HEADER_GRANTED,
  isAnalyticsCaptureUrl,
} from './consent-header';
export {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  CONSENT_COOKIE_REGION_DEFAULT_PART,
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

export { AD_PIXEL_COOKIE_NAMES, adPixelCookieExpiries } from './ad-pixel-cookies';
