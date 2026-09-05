// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export const locationSyncAdminTypeDefs = /* GraphQL */ `
  enum LocationSyncEntityType {
    GYM
    BOARD
  }

  enum ClearLocationSyncFreezeStatus {
    CLEARED
    ALREADY_UNFROZEN
  }

  "A gym or board whose human-curation marker currently blocks location-sync writes."
  type FrozenLocationSyncEntity {
    entityType: LocationSyncEntityType!
    entityUuid: ID!
    slug: String
    name: String!
    boardType: String
    isSystemOwned: Boolean!
    "A separate gym ownership or approved-claim guard still prevents source metadata refreshes."
    ownerProtected: Boolean!
    isDeleted: Boolean!
    deletedAt: String
    syncFrozenAt: String!
    "Known upstream source aliases. Empty for boards because board source keys are not persisted."
    sourceKeys: [String!]!
  }

  type FrozenLocationSyncEntityConnection {
    entities: [FrozenLocationSyncEntity!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  input FrozenLocationSyncEntitiesInput {
    entityType: LocationSyncEntityType!
    "Optional case-insensitive name, UUID, or slug search."
    query: String
    limit: Int
    offset: Int
  }

  input ClearLocationSyncFreezeInput {
    entityType: LocationSyncEntityType!
    entityUuid: ID!
    "Freeze timestamp shown to the administrator; prevents a stale dialog clearing a newer edit."
    expectedSyncFrozenAt: String!
    "Required operator explanation stored in the durable audit trail."
    reason: String!
  }

  type ClearLocationSyncFreezeResult {
    status: ClearLocationSyncFreezeStatus!
    entityType: LocationSyncEntityType!
    entityUuid: ID!
    previousSyncFrozenAt: String
  }
`;
