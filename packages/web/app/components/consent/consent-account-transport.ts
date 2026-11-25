import type { createConsentSyncCoordinator } from '@boardsesh/consent';
import {
  GET_MY_ANALYTICS_CONSENT,
  SET_ANALYTICS_CONSENT,
  type GetMyAnalyticsConsentResponse,
  type SetAnalyticsConsentResponse,
} from '@boardsesh/graphql/operations/analytics-consent';
import { executeGraphQL } from '@/app/lib/graphql/client';

type CoordinatorOptions = Parameters<typeof createConsentSyncCoordinator>[0];
export type ConsentAccountTransport = {
  read: (token: string) => ReturnType<CoordinatorOptions['readAccountConsent']>;
  write: (
    token: string,
    input: Parameters<CoordinatorOptions['writeAccountConsent']>[1],
  ) => ReturnType<CoordinatorOptions['writeAccountConsent']>;
};

export const consentAccountTransport: ConsentAccountTransport = {
  read: async (token) =>
    (await executeGraphQL<GetMyAnalyticsConsentResponse>(GET_MY_ANALYTICS_CONSENT, undefined, token))
      .myAnalyticsConsent,
  write: async (token, input) =>
    (await executeGraphQL<SetAnalyticsConsentResponse>(SET_ANALYTICS_CONSENT, { input }, token)).setAnalyticsConsent,
};
