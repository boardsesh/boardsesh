import { gql } from 'graphql-request';
import type { AppleAdsAttributionResult, AppleAdsConsentInput } from '@boardsesh/shared-schema';

// Always use variables. Never put an AdServices token into the document/URL.
export const EXCHANGE_APPLE_ADS_ATTRIBUTION = gql`
  mutation ExchangeAppleAdsAttribution($token: String!, $consent: AppleAdsConsentInput!) {
    exchangeAppleAdsAttribution(token: $token, consent: $consent) {
      status
      retryAfterSeconds
      retryReason
      attribution {
        orgId
        campaignId
        adGroupId
        keywordId
        adId
        conversionType
        claimType
        countryOrRegion
        supplyPlacement
      }
    }
  }
`;

export type ExchangeAppleAdsAttributionVariables = { token: string; consent: AppleAdsConsentInput };
export type ExchangeAppleAdsAttributionResponse = { exchangeAppleAdsAttribution: AppleAdsAttributionResult };
