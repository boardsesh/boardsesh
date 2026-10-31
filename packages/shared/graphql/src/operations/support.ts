import { gql } from 'graphql-request';

// Supporter operations, shared by web and mobile. The whole system (claims,
// credit rule, tag rule, webhook) is described in docs/supporters.md.

const MY_SUPPORTER_STATUS_FIELDS = `
  isSupporter
  showPublicly
  source
  creditUntil
  hasSubscription
  cancelAtPeriodEnd
`;

export const GET_MY_SUPPORTER_STATUS = gql`
  query GetMySupporterStatus {
    mySupporterStatus {
      ${MY_SUPPORTER_STATUS_FIELDS}
    }
  }
`;

export const UPDATE_SUPPORTER_VISIBILITY = gql`
  mutation UpdateSupporterVisibility($showPublicly: Boolean!) {
    updateSupporterVisibility(showPublicly: $showPublicly) {
      ${MY_SUPPORTER_STATUS_FIELDS}
    }
  }
`;

export const CLAIM_SUPPORTER_BY_EMAIL = gql`
  mutation ClaimSupporterByEmail {
    claimSupporterByEmail {
      ${MY_SUPPORTER_STATUS_FIELDS}
    }
  }
`;

export const CREATE_SUPPORT_CLAIM = gql`
  mutation CreateSupportClaim($cadence: String!, $currency: String!, $src: String) {
    createSupportClaim(cadence: $cadence, currency: $currency, src: $src)
  }
`;

export const GET_PUBLIC_SUPPORTERS = gql`
  query GetPublicSupporters($limit: Int!, $offset: Int!) {
    publicSupporters(limit: $limit, offset: $offset) {
      userId
      displayName
      avatarUrl
    }
  }
`;

export type MySupporterStatus = {
  isSupporter: boolean;
  showPublicly: boolean;
  /** `stripe`, `github_sponsors` or `admin`; null before any support. */
  source: string | null;
  /** ISO 8601, when one-off or granted time runs out. */
  creditUntil: string | null;
  hasSubscription: boolean;
  cancelAtPeriodEnd: boolean;
};

export type SupportClaimCadence = 'monthly' | 'one_time';

export type GetMySupporterStatusResponse = { mySupporterStatus: MySupporterStatus | null };
export type UpdateSupporterVisibilityResponse = { updateSupporterVisibility: MySupporterStatus };
export type UpdateSupporterVisibilityVariables = { showPublicly: boolean };
export type ClaimSupporterByEmailResponse = { claimSupporterByEmail: MySupporterStatus };
export type CreateSupportClaimResponse = { createSupportClaim: string };
export type CreateSupportClaimVariables = {
  cadence: SupportClaimCadence;
  currency: 'aud' | 'usd';
  src?: string | null;
};

export type PublicSupporter = {
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type GetPublicSupportersResponse = { publicSupporters: PublicSupporter[] };
export type GetPublicSupportersVariables = { limit: number; offset: number };

/** The backend's per-page ceiling for `publicSupporters`. */
export const PUBLIC_SUPPORTERS_PAGE_SIZE = 500;
export const PUBLIC_SUPPORTERS_MAX_PAGES = 20;

/** Offset pages may overlap when someone's visibility changes between requests. */
export function deduplicatePublicSupporters(supporters: PublicSupporter[]): PublicSupporter[] {
  const seenUserIds = new Set<string>();
  return supporters.filter((supporter) => {
    if (seenUserIds.has(supporter.userId)) return false;
    seenUserIds.add(supporter.userId);
    return true;
  });
}

/** Every public supporter, page by page, stopping at the first short page or the page ceiling. */
export async function fetchAllPublicSupporters(
  requestPage: (variables: GetPublicSupportersVariables) => Promise<GetPublicSupportersResponse>,
): Promise<PublicSupporter[]> {
  const supporters: PublicSupporter[] = [];
  for (let pageIndex = 0; pageIndex < PUBLIC_SUPPORTERS_MAX_PAGES; pageIndex += 1) {
    const page = await requestPage({
      limit: PUBLIC_SUPPORTERS_PAGE_SIZE,
      offset: pageIndex * PUBLIC_SUPPORTERS_PAGE_SIZE,
    });
    supporters.push(...page.publicSupporters);
    if (page.publicSupporters.length < PUBLIC_SUPPORTERS_PAGE_SIZE) break;
  }
  return deduplicatePublicSupporters(supporters);
}
