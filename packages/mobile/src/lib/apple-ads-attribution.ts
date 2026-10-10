import { randomUUID } from 'expo-crypto';
import { EXCHANGE_APPLE_ADS_ATTRIBUTION } from '@boardsesh/graphql/operations/apple-ads-attribution';
import {
  normalizeAppleAdsAttributionPayload,
  type AppleAdsAttributionResult,
} from '@boardsesh/shared-schema/apple-ads-attribution';
import type { ConsentRecord } from '@boardsesh/consent';
import { getAppleAdsAttributionToken } from '../../modules/apple-ads-attribution/src';
import { capture, getAnalyticsIdentity, setPersonProperties } from './analytics';
import { getConsentSnapshot, isConsentAuthorityGranted, isProductAnalyticsGranted } from './consent-state';
import { getHttpClient } from './graphql/client';
import { getPreference, setPreference } from './preference-store';
import { getVerifiedAuthResult } from './verified-auth-result';
import {
  APPLE_ADS_ATTRIBUTION_STORAGE_KEY,
  createAppleAdsAttributionController,
  type StoredAppleAdsAttribution,
} from './apple-ads-attribution-controller';

const UNAVAILABLE: AppleAdsAttributionResult = {
  status: 'RETRYABLE',
  attribution: null,
  retryAfterSeconds: 5,
  retryReason: 'unavailable',
};

/** Own every raw graphql-request failure: ClientError embeds token variables. */
export async function exchangeAppleAdsAttribution(
  token: string,
  consent: ConsentRecord,
  signal: AbortSignal,
): Promise<AppleAdsAttributionResult> {
  try {
    const response = await getHttpClient().request<{ exchangeAppleAdsAttribution: AppleAdsAttributionResult }>({
      document: EXCHANGE_APPLE_ADS_ATTRIBUTION,
      variables: { token, consent },
      signal,
    });
    const result = response.exchangeAppleAdsAttribution;
    if (result.status === 'ATTRIBUTED') {
      return normalizeAppleAdsAttributionPayload({ ...result.attribution, attribution: true });
    }
    if (
      result.status === 'UNATTRIBUTED' ||
      result.status === 'TEST' ||
      result.status === 'CONSENT_REQUIRED' ||
      result.status === 'INVALID_TOKEN'
    ) {
      return { status: result.status, attribution: null, retryAfterSeconds: null, retryReason: null };
    }
    if (result.status === 'RETRYABLE') {
      return {
        status: 'RETRYABLE',
        attribution: null,
        retryAfterSeconds: Number.isFinite(result.retryAfterSeconds) ? result.retryAfterSeconds : 5,
        retryReason:
          result.retryReason === 'not_ready' || result.retryReason === 'rate_limited'
            ? result.retryReason
            : 'unavailable',
      };
    }
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

function publishAppleAdsAttribution(
  record: StoredAppleAdsAttribution,
  distinctId: string,
  emitEvent: boolean,
): boolean {
  if (!isProductAnalyticsGranted() || getAnalyticsIdentity()?.distinctId !== distinctId || !record.result) return false;
  const attribution = record.result.attribution;
  const properties = {
    attribution_provider: 'apple_ads',
    apple_ads_attribution_status: record.result.status.toLowerCase(),
    apple_ads_org_id: attribution?.orgId,
    apple_ads_campaign_id: attribution?.campaignId,
    apple_ads_ad_group_id: attribution?.adGroupId,
    apple_ads_keyword_id: attribution?.keywordId ?? undefined,
    apple_ads_ad_id: attribution?.adId ?? undefined,
    apple_ads_conversion_type: attribution?.conversionType,
    apple_ads_claim_type: attribution?.claimType ?? undefined,
    apple_ads_country_or_region: attribution?.countryOrRegion ?? undefined,
    apple_ads_supply_placement: attribution?.supplyPlacement ?? undefined,
  };
  if (!setPersonProperties(undefined, properties)) return false;
  if (!isProductAnalyticsGranted() || getAnalyticsIdentity()?.distinctId !== distinctId) return false;
  return (
    !emitEvent ||
    capture('Install Attributed', properties, {
      uuid: record.eventUuid,
      timestamp: new Date(record.observedAt),
    })
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createNativeAppleAdsAttributionController() {
  return createAppleAdsAttributionController({
    snapshot: getConsentSnapshot,
    verifiedAccountId: () => getVerifiedAuthResult()?.userId ?? getConsentSnapshot().accountId,
    authorityGranted: isConsentAuthorityGranted,
    publicationGranted: isProductAnalyticsGranted,
    identity: getAnalyticsIdentity,
    read: () => getPreference<unknown>(APPLE_ADS_ATTRIBUTION_STORAGE_KEY, { strictParsing: true }),
    write: (record) => setPreference(APPLE_ADS_ATTRIBUTION_STORAGE_KEY, record),
    token: getAppleAdsAttributionToken,
    exchange: exchangeAppleAdsAttribution,
    publish: publishAppleAdsAttribution,
    delay,
    uuid: randomUUID,
    now: Date.now,
  });
}
