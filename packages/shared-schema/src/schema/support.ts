export const supportTypeDefs = /* GraphQL */ `
  enum SupportCadence {
    MONTHLY
    ONE_TIME
  }

  type SupportConfiguration {
    enabled: Boolean!
    currency: String!
    minimumAmount: Int!
    maximumAmount: Int!
    legacyDonateUrl: String
  }

  type SupporterStatus {
    linked: Boolean!
    hasSupported: Boolean!
    showPublicly: Boolean!
    hasActiveSubscription: Boolean!
    cancelAtPeriodEnd: Boolean!
  }

  type PublicSupporter {
    userId: ID!
    displayName: String!
    avatarUrl: String
    supportedAt: String!
  }

  input CreateSupportCheckoutSessionInput {
    amount: Int!
    cadence: SupportCadence!
    publicCredit: Boolean!
    locale: String
  }

  type SupportCheckoutSession {
    url: String!
  }

  type SupportBillingPortalSession {
    url: String!
  }
`;
