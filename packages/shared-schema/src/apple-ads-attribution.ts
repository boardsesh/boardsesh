import type { AppleAdsAttribution, AppleAdsAttributionResult } from './types/apple-ads-attribution';
export type * from './types/apple-ads-attribution';

const APPLE_ADS_TEST_ID = '1234567890';

/** Apple IDs are integers; reject numbers that JSON decoding could have rounded. */
function normalizeId(identifier: unknown): string | undefined {
  if (typeof identifier !== 'number' && typeof identifier !== 'string') return undefined;
  if (typeof identifier === 'string' && !/^[1-9]\d*$/.test(identifier)) return undefined;
  const numericIdentifier = Number(identifier);
  return Number.isSafeInteger(numericIdentifier) && numericIdentifier > 0 ? String(numericIdentifier) : undefined;
}

/**
 * Shared by the backend's Apple response and mobile's persisted cache validator.
 * Only campaign fields needed for attribution survive; dates and unknown fields
 * never do. For a normalized cache, supply { attribution: true, ...cached }.
 */
export function normalizeAppleAdsAttributionPayload(payload: unknown): AppleAdsAttributionResult {
  const unavailable = (): AppleAdsAttributionResult => ({
    status: 'RETRYABLE',
    attribution: null,
    retryAfterSeconds: 5,
    retryReason: 'unavailable',
  });
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return unavailable();
  const fields = payload as Record<string, unknown>;
  if (fields.attribution === false) {
    return { status: 'UNATTRIBUTED', attribution: null, retryAfterSeconds: null, retryReason: null };
  }
  if (fields.attribution !== true) return unavailable();

  const orgId = normalizeId(fields.orgId);
  const campaignId = normalizeId(fields.campaignId);
  const adGroupId = normalizeId(fields.adGroupId);
  const keywordId = normalizeId(fields.keywordId);
  const adId = normalizeId(fields.adId);
  if ([orgId, campaignId, adGroupId, keywordId, adId].includes(APPLE_ADS_TEST_ID)) {
    return { status: 'TEST', attribution: null, retryAfterSeconds: null, retryReason: null };
  }
  if (!orgId || !campaignId || !adGroupId) return unavailable();

  const conversionType = fields.conversionType;
  if (conversionType !== 'Download' && conversionType !== 'Redownload' && conversionType !== 'PreOrder') {
    return unavailable();
  }
  const attribution: AppleAdsAttribution = { orgId, campaignId, adGroupId, conversionType };
  if (keywordId) attribution.keywordId = keywordId;
  if (adId) attribution.adId = adId;
  if (fields.claimType === 'Click' || fields.claimType === 'Impression') attribution.claimType = fields.claimType;
  if (typeof fields.countryOrRegion === 'string' && /^[A-Z]{2}$/.test(fields.countryOrRegion)) {
    attribution.countryOrRegion = fields.countryOrRegion;
  }
  if (
    fields.supplyPlacement === 'APPSTORE_PRODUCT_PAGES' ||
    fields.supplyPlacement === 'APPSTORE_SEARCH_RESULTS' ||
    fields.supplyPlacement === 'APPSTORE_SEARCH_TAB' ||
    fields.supplyPlacement === 'APPSTORE_TODAY_TAB'
  ) {
    attribution.supplyPlacement = fields.supplyPlacement;
  }
  return { status: 'ATTRIBUTED', attribution, retryAfterSeconds: null, retryReason: null };
}
