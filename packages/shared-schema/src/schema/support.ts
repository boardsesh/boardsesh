export const supportTypeDefs = /* GraphQL */ `
  """
  The signed-in climber's supporter record. The tag shows on their public
  profile only while isSupporter and showPublicly are both true.
  """
  type MySupporterStatus {
    "A live monthly subscription, or one-off or granted time that has not run out"
    isSupporter: Boolean!
    "Whether the climber chose to be named on public supporter lists and their profile"
    showPublicly: Boolean!
    "How the current status was recorded: stripe, github_sponsors or admin. Null before any support."
    source: String
    "When one-off or granted time runs out (ISO 8601). Null when there is none."
    creditUntil: String
    "Whether a live monthly subscription is linked to this account"
    hasSubscription: Boolean!
    "Whether the linked subscription ends at the close of its current period"
    cancelAtPeriodEnd: Boolean!
  }

  "A supporter who chose public credit and is currently a supporter."
  type PublicSupporter {
    userId: ID!
    displayName: String!
    avatarUrl: String
  }

  extend type PublicUserProfile {
    """
    True when this climber is currently a supporter and chose public credit.
    False when the viewer cannot see the profile's activity.
    Only resolved by publicProfile; null elsewhere.
    """
    isSupporter: Boolean
  }

  extend type Query {
    "The signed-in climber's supporter record. Null when signed out."
    mySupporterStatus: MySupporterStatus
    "Current supporters who chose public credit, newest first. limit defaults to 100, at most 500."
    publicSupporters(limit: Int, offset: Int): [PublicSupporter!]!
  }

  extend type Mutation {
    """
    Start a support payment from a signed-in account. Returns an opaque claim id
    the client passes to the Stripe Payment Link as client_reference_id, so the
    payment links back to this account. cadence: monthly or one_time. currency:
    aud or usd. src: the page tag (lowercase letters, digits and dashes).
    """
    createSupportClaim(cadence: String!, currency: String!, src: String): String!
    "Show or hide the signed-in climber on public supporter lists and their profile."
    updateSupporterVisibility(showPublicly: Boolean!): MySupporterStatus!
    """
    Find support paid with this account's verified email in Stripe and link it:
    one-off payments add time once per payment, and a live monthly
    subscription is linked when none is.
    """
    claimSupporterByEmail: MySupporterStatus!
    "Admin only: record supporter status by hand (source github_sponsors or admin) until creditUntil."
    grantSupporter(userId: ID!, source: String!, creditUntil: String!): MySupporterStatus!
  }
`;
