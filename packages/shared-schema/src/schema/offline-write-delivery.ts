export const offlineWriteDeliveryTypeDefs = `
  input OfflineWriteReleaseInput {
    applicationId: String
    platform: String!
    appVersion: String
    runtimeVersion: String
    updateId: String
    isEmbedded: Boolean
    branch: String
  }

  input OfflineWriteObservationInput {
    deliveryId: ID!
    tableName: String!
    operation: String!
    queuedAt: String!
    connectivityReason: String!
    originRelease: OfflineWriteReleaseInput!
    state: String!
    observedAt: String!
    revision: Int!
    recovered: Boolean!
    serverResponseAt: String
    reconciledAt: String
    firstDeadLetterAt: String
    lastDeadLetterAt: String
    observedRelease: OfflineWriteReleaseInput
  }

  input RecordOfflineWriteObservationsInput {
    ownerUserId: ID!
    observations: [OfflineWriteObservationInput!]!
  }

  type OfflineWriteDeliveryReceipt {
    deliveryId: ID!
    revision: Int!
    serverAcceptedAt: String
    serverRejectedAt: String
  }

  type RecordOfflineWriteObservationsResult {
    receipts: [OfflineWriteDeliveryReceipt!]!
  }

  extend type Mutation {
    "Private account-scoped delivery evidence, independent of product analytics consent."
    recordOfflineWriteObservations(input: RecordOfflineWriteObservationsInput!): RecordOfflineWriteObservationsResult!
  }
`;
