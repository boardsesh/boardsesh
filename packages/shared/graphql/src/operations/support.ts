import { gql } from 'graphql-request';

export const GET_SUPPORT_PAGE = gql`
  query GetSupportPage {
    supportConfiguration {
      enabled
      currency
      minimumAmount
      maximumAmount
      legacyDonateUrl
    }
    mySupporterStatus {
      linked
      hasSupported
      showPublicly
      hasActiveSubscription
      cancelAtPeriodEnd
    }
  }
`;

export const GET_PUBLIC_SUPPORTERS = gql`
  query GetPublicSupporters($limit: Int!, $offset: Int!) {
    publicSupporters(limit: $limit, offset: $offset) {
      userId
      displayName
      avatarUrl
      supportedAt
    }
  }
`;

export const CREATE_SUPPORT_CHECKOUT = gql`
  mutation CreateSupportCheckout($input: CreateSupportCheckoutSessionInput!) {
    createSupportCheckoutSession(input: $input) {
      url
    }
  }
`;

export const UPDATE_SUPPORTER_VISIBILITY = gql`
  mutation UpdateSupporterVisibility($showPublicly: Boolean!) {
    updateSupporterVisibility(showPublicly: $showPublicly) {
      linked
      hasSupported
      showPublicly
      hasActiveSubscription
      cancelAtPeriodEnd
    }
  }
`;

export const CREATE_SUPPORT_BILLING_PORTAL = gql`
  mutation CreateSupportBillingPortal($locale: String) {
    createSupportBillingPortalSession(locale: $locale) {
      url
    }
  }
`;

export type SupportConfiguration = {
  enabled: boolean;
  currency: string;
  minimumAmount: number;
  maximumAmount: number;
  legacyDonateUrl?: string | null;
};

export type SupporterStatus = {
  linked: boolean;
  hasSupported: boolean;
  showPublicly: boolean;
  hasActiveSubscription: boolean;
  cancelAtPeriodEnd: boolean;
};

export type PublicSupporter = {
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  supportedAt: string;
};

export type GetSupportPageResponse = {
  supportConfiguration: SupportConfiguration;
  mySupporterStatus: SupporterStatus;
};

export type GetPublicSupportersResponse = { publicSupporters: PublicSupporter[] };
export type GetPublicSupportersVariables = { limit: number; offset: number };

export const PUBLIC_SUPPORTERS_PAGE_SIZE = 500;

export async function fetchAllPublicSupporters(
  requestPage: (variables: GetPublicSupportersVariables) => Promise<GetPublicSupportersResponse>,
): Promise<PublicSupporter[]> {
  const supporters: PublicSupporter[] = [];
  for (let offset = 0; ; offset += PUBLIC_SUPPORTERS_PAGE_SIZE) {
    const page = await requestPage({ limit: PUBLIC_SUPPORTERS_PAGE_SIZE, offset });
    supporters.push(...page.publicSupporters);
    if (page.publicSupporters.length < PUBLIC_SUPPORTERS_PAGE_SIZE) return supporters;
  }
}
