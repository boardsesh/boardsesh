import { gql } from 'graphql-request';
import type { AnalyticsConsent, ConsentRegion, SetAnalyticsConsentInput } from '@boardsesh/shared-schema';

const ANALYTICS_CONSENT_FIELDS = gql`
  fragment AnalyticsConsentFields on AnalyticsConsent {
    analytics
    version
    source
    decidedAt
  }
`;

export const GET_MY_ANALYTICS_CONSENT = gql`
  query GetMyAnalyticsConsent {
    myAnalyticsConsent {
      ...AnalyticsConsentFields
    }
  }
  ${ANALYTICS_CONSENT_FIELDS}
`;

export type GetMyAnalyticsConsentResponse = { myAnalyticsConsent: AnalyticsConsent | null };

export const SET_ANALYTICS_CONSENT = gql`
  mutation SetAnalyticsConsent($input: SetAnalyticsConsentInput!) {
    setAnalyticsConsent(input: $input) {
      ...AnalyticsConsentFields
    }
  }
  ${ANALYTICS_CONSENT_FIELDS}
`;

export type SetAnalyticsConsentVariables = { input: SetAnalyticsConsentInput };
export type SetAnalyticsConsentResponse = { setAnalyticsConsent: AnalyticsConsent };

/**
 * Whether this device's region gets the analytics prompt. Signed out works.
 * Clients ask only while the device has no answer (or holds a region default).
 */
export const GET_CONSENT_REGION = gql`
  query GetConsentRegion {
    consentRegion {
      countryCode
      promptRequired
      globalPrivacyControl
    }
  }
`;

export type GetConsentRegionResponse = { consentRegion: ConsentRegion };
