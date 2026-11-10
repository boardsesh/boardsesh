export const projectNewsEmailTypeDefs = /* GraphQL */ `
  """
  Whether the signed-in climber gets project news by email. Off until they turn
  it on. See docs/project-news-email.md.
  """
  type ProjectNewsEmailConsent {
    "True only after the climber switched it on, and until they switch it off or unsubscribe."
    subscribed: Boolean!
    "ISO 8601 server time of the current answer, or null when the climber never answered."
    decidedAt: String
  }

  input SetProjectNewsEmailConsentInput {
    "True to opt in, false to opt out."
    subscribed: Boolean!
    "web, ios or android: where the climber flipped the switch."
    source: String!
  }

  extend type Query {
    "The signed-in climber's project news email answer. Never answered reads as off."
    myProjectNewsEmailConsent: ProjectNewsEmailConsent!
  }

  extend type Mutation {
    "Turn project news email on or off for the signed-in climber and return the account's answer."
    setProjectNewsEmailConsent(input: SetProjectNewsEmailConsentInput!): ProjectNewsEmailConsent!
  }
`;
