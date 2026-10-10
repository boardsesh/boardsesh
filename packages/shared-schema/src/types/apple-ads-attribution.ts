/** Explicit device consent snapshot supplied with an AdServices exchange. */
export type AppleAdsConsentInput = {
  analytics: 'granted' | 'denied';
  version: number;
  source: 'web' | 'ios' | 'android';
  decidedAt: string;
};

export type AppleAdsAttributionStatus =
  | 'ATTRIBUTED'
  | 'UNATTRIBUTED'
  | 'TEST'
  | 'INVALID_TOKEN'
  | 'RETRYABLE'
  | 'CONSENT_REQUIRED';

export type AppleAdsAttributionRetryReason = 'not_ready' | 'unavailable' | 'rate_limited';

/** Only campaign fields needed for the install/signup funnel leave the backend. */
export type AppleAdsAttribution = {
  orgId: string;
  campaignId: string;
  adGroupId: string;
  keywordId?: string | null;
  adId?: string | null;
  conversionType: 'Download' | 'Redownload' | 'PreOrder';
  claimType?: 'Click' | 'Impression' | null;
  countryOrRegion?: string | null;
  supplyPlacement?:
    | 'APPSTORE_PRODUCT_PAGES'
    | 'APPSTORE_SEARCH_RESULTS'
    | 'APPSTORE_SEARCH_TAB'
    | 'APPSTORE_TODAY_TAB'
    | null;
};

export type AppleAdsAttributionResult = {
  status: AppleAdsAttributionStatus;
  attribution: AppleAdsAttribution | null;
  retryAfterSeconds: number | null;
  retryReason: AppleAdsAttributionRetryReason | null;
};
