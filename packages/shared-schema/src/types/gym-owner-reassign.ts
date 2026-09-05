// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export type GymOwnershipSummary = {
  gymUuid: string;
  slug?: string | null;
  name: string;
  currentOwnerId: string;
  /** Display name / account email of the current owner; null when the account row is gone. */
  currentOwnerLabel?: string | null;
  /** True while the listing is still parked on the import account. */
  currentOwnerIsSystem: boolean;
  syncFrozenAt?: string | null;
  isDeleted: boolean;
  isMerged: boolean;
};

export type GymOwnershipUserSummary = {
  userId: string;
  label: string;
  email?: string | null;
};

export type GymOwnershipLookupInput = {
  gymQuery: string;
  newOwnerQuery: string;
};

export type GymOwnershipLookupResult = {
  gym?: GymOwnershipSummary | null;
  newOwner?: GymOwnershipUserSummary | null;
};

export type ReassignGymOwnerInput = {
  gymUuid: string;
  expectedCurrentOwnerId: string;
  newOwnerId: string;
  reason: string;
};

export type ReassignGymOwnerResult = {
  gymUuid: string;
  gymName: string;
  previousOwnerId: string;
  newOwnerId: string;
  /** The freeze marker after the write — a handover never changes it. */
  syncFrozenAt?: string | null;
};
