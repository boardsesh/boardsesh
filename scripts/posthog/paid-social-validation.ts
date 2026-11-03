/** Exact queries executed live in PostHog; their hashes and row counts are in paid-social-validation.json. */
import {
  type PaidSocialWindow,
  paidSocialAdsQuery,
  paidSocialAndroidInstallsQuery,
  paidSocialAndroidOutcomesQuery,
  paidSocialLandingQuery,
  paidSocialStoreClicksQuery,
} from './paid-social-queries';

export const PAID_SOCIAL_VALIDATION_WINDOW: PaidSocialWindow = {
  from: "toDateTime('2026-10-06 00:00:00')",
  to: "toDateTime('2026-11-03 00:00:00')",
  cutoff: "toDateTime('2026-11-03 00:00:00')",
};

/**
 * Paid sources have no traffic before the first ad, so the same SQL also runs against sources that
 * already exist (an Instagram bio tagged `ig`, ChatGPT, our own store links) to exercise the joins.
 */
const PROBE_WWW_SOURCES = ['ig', 'chatgpt.com'];
const PROBE_INSTALL_SOURCES = ['boardsesh', 'chatgpt.com'];
const validationWindow = PAID_SOCIAL_VALIDATION_WINDOW;

export const paidSocialValidationQueries = {
  landing: paidSocialLandingQuery(validationWindow),
  storeClicks: paidSocialStoreClicksQuery(validationWindow),
  ads: paidSocialAdsQuery(validationWindow),
  androidInstalls: paidSocialAndroidInstallsQuery(validationWindow),
  androidOutcomes: paidSocialAndroidOutcomesQuery(validationWindow),
  probeLanding: paidSocialLandingQuery(validationWindow, PROBE_WWW_SOURCES),
  probeStoreClicks: paidSocialStoreClicksQuery(validationWindow, PROBE_WWW_SOURCES),
  probeAds: paidSocialAdsQuery(validationWindow, PROBE_WWW_SOURCES),
  probeAndroidInstalls: paidSocialAndroidInstallsQuery(validationWindow, PROBE_INSTALL_SOURCES),
  probeAndroidOutcomes: paidSocialAndroidOutcomesQuery(validationWindow, PROBE_INSTALL_SOURCES),
};
