// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export const gymOwnerReassignTypeDefs = /* GraphQL */ `
  "A gym resolved for the admin ownership-handover surface, with the state the confirm step must name."
  type GymOwnershipSummary {
    gymUuid: ID!
    slug: String
    name: String!
    "Echoed back so the mutation can be sent with the exact owner the admin saw."
    currentOwnerId: ID!
    "Display name / account email of the current owner, or null when the account row is gone."
    currentOwnerLabel: String
    "True when the listing is still parked on the import account and has no real owner yet."
    currentOwnerIsSystem: Boolean!
    "The listing's human-curation marker. A handover leaves it exactly as it is."
    syncFrozenAt: String
    isDeleted: Boolean!
    isMerged: Boolean!
  }

  "The incoming owner resolved from an account email or user id."
  type GymOwnershipUserSummary {
    userId: ID!
    label: String!
    email: String
  }

  input GymOwnershipLookupInput {
    "Gym UUID, slug, or a case-insensitive name fragment."
    gymQuery: String!
    "Account email or user id of the person the gym should move to."
    newOwnerQuery: String!
  }

  "Both sides of a proposed handover. Either half is null when nothing matched."
  type GymOwnershipLookupResult {
    gym: GymOwnershipSummary
    newOwner: GymOwnershipUserSummary
  }

  input ReassignGymOwnerInput {
    gymUuid: ID!
    "Owner the admin saw in the confirm step; a moved owner rejects the write."
    expectedCurrentOwnerId: ID!
    newOwnerId: ID!
    "Required operator explanation stored in the durable audit trail."
    reason: String!
  }

  type ReassignGymOwnerResult {
    gymUuid: ID!
    gymName: String!
    previousOwnerId: ID!
    newOwnerId: ID!
    "The human-curation marker after the write. A handover never changes it."
    syncFrozenAt: String
  }
`;
