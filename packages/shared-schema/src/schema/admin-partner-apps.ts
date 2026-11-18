export const adminPartnerAppsTypeDefs = /* GraphQL */ `
  "Global-admin app directory. Never contains client credentials or connected climber identities."
  type AdminPartnerApp {
    clientId: ID!
    name: String
    publisherName: String
    ownerUserId: ID!
    ownerName: String
    ownerEmail: String
    homepageUrl: String
    createdAt: String!
    disabled: Boolean!
    suspendedAt: String
    suspensionReason: String
    activeConnections: Int!
    newConnectionsLast24Hours: Int!
    maxActiveConnections: Int!
    maxNewConnectionsPerDay: Int!
  }

  type AdminPartnerAppConnection {
    apps: [AdminPartnerApp!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  input AdminPartnerAppsInput {
    query: String
    limit: Int
    offset: Int
  }

  input UpdatePartnerAppLimitsInput {
    clientId: ID!
    maxActiveConnections: Int!
    maxNewConnectionsPerDay: Int!
  }

  extend type Query {
    adminPartnerApps(input: AdminPartnerAppsInput): AdminPartnerAppConnection!
  }

  extend type Mutation {
    updatePartnerAppLimits(input: UpdatePartnerAppLimitsInput!): AdminPartnerApp!
  }
`;
