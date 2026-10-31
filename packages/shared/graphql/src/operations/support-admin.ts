import { gql } from 'graphql-request';

/** Admin only: record supporter status by hand until `creditUntil` (docs/supporters.md). */
export const GRANT_SUPPORTER = gql`
  mutation GrantSupporter($userId: ID!, $source: String!, $creditUntil: String!) {
    grantSupporter(userId: $userId, source: $source, creditUntil: $creditUntil) {
      isSupporter
      showPublicly
      source
      creditUntil
      hasSubscription
      cancelAtPeriodEnd
    }
  }
`;

/** The sources an admin may grant. Stripe records come from the webhook only. */
export const GRANTABLE_SUPPORTER_SOURCES = ['github_sponsors', 'admin'] as const;
export type GrantableSupporterSource = (typeof GRANTABLE_SUPPORTER_SOURCES)[number];

export type GrantSupporterMutationVariables = {
  userId: string;
  source: GrantableSupporterSource;
  creditUntil: string;
};

export type GrantSupporterMutationResponse = {
  grantSupporter: {
    isSupporter: boolean;
    showPublicly: boolean;
    source: string | null;
    creditUntil: string | null;
    hasSubscription: boolean;
    cancelAtPeriodEnd: boolean;
  };
};
