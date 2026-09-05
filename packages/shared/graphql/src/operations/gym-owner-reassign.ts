// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';
import type {
  GymOwnershipLookupInput,
  GymOwnershipLookupResult,
  ReassignGymOwnerInput,
  ReassignGymOwnerResult,
} from '@boardsesh/shared-schema';

export const GYM_OWNERSHIP_LOOKUP = gql`
  query GymOwnershipLookup($input: GymOwnershipLookupInput!) {
    gymOwnershipLookup(input: $input) {
      gym {
        gymUuid
        slug
        name
        currentOwnerId
        currentOwnerLabel
        currentOwnerIsSystem
        syncFrozenAt
        isDeleted
        isMerged
      }
      newOwner {
        userId
        label
        email
      }
    }
  }
`;

export const REASSIGN_GYM_OWNER = gql`
  mutation ReassignGymOwner($input: ReassignGymOwnerInput!) {
    reassignGymOwner(input: $input) {
      gymUuid
      gymName
      previousOwnerId
      newOwnerId
      syncFrozenAt
    }
  }
`;

export type GymOwnershipLookupQueryVariables = {
  input: GymOwnershipLookupInput;
};

export type GymOwnershipLookupQueryResponse = {
  gymOwnershipLookup: GymOwnershipLookupResult;
};

export type ReassignGymOwnerMutationVariables = {
  input: ReassignGymOwnerInput;
};

export type ReassignGymOwnerMutationResponse = {
  reassignGymOwner: ReassignGymOwnerResult;
};
