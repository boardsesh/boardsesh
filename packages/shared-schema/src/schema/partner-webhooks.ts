export const partnerWebhooksTypeDefs = /* GraphQL */ `
  type PartnerWebhookSettings {
    clientId: ID!
    url: String!
    events: [String!]!
    enabled: Boolean!
    disabledReason: String
    previousSecretExpiresAt: String
  }
  type PartnerWebhookCredentials {
    settings: PartnerWebhookSettings!
    secret: String
  }
  type PartnerWebhookDelivery {
    id: ID!
    event: String!
    status: String!
    attempts: Int!
    lastStatusCode: Int
    lastError: String
    createdAt: String!
    deliveredAt: String
  }
  input UpdatePartnerWebhookInput {
    clientId: ID!
    url: String!
    events: [String!]!
    enabled: Boolean!
  }
  extend type Query {
    partnerWebhookSettings(clientId: ID!): PartnerWebhookSettings
    partnerWebhookDeliveries(clientId: ID!): [PartnerWebhookDelivery!]!
  }
  extend type Mutation {
    updatePartnerWebhook(input: UpdatePartnerWebhookInput!): PartnerWebhookCredentials!
    rotatePartnerWebhookSecret(clientId: ID!): PartnerWebhookCredentials!
    testPartnerWebhook(clientId: ID!): ID!
  }
`;
