// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';
import type {
  ClearLocationSyncFreezeInput,
  ClearLocationSyncFreezeResult,
  FrozenLocationSyncEntitiesInput,
  FrozenLocationSyncEntityConnection,
} from '@boardsesh/shared-schema';

export const FROZEN_LOCATION_SYNC_ENTITIES = gql`
  query FrozenLocationSyncEntities($input: FrozenLocationSyncEntitiesInput!) {
    frozenLocationSyncEntities(input: $input) {
      entities {
        entityType
        entityUuid
        slug
        name
        boardType
        isSystemOwned
        ownerProtected
        isDeleted
        deletedAt
        syncFrozenAt
        sourceKeys
      }
      totalCount
      hasMore
    }
  }
`;

export const CLEAR_LOCATION_SYNC_FREEZE = gql`
  mutation ClearLocationSyncFreeze($input: ClearLocationSyncFreezeInput!) {
    clearLocationSyncFreeze(input: $input) {
      status
      entityType
      entityUuid
      previousSyncFrozenAt
    }
  }
`;

export type FrozenLocationSyncEntitiesQueryVariables = {
  input: FrozenLocationSyncEntitiesInput;
};

export type FrozenLocationSyncEntitiesQueryResponse = {
  frozenLocationSyncEntities: FrozenLocationSyncEntityConnection;
};

export type ClearLocationSyncFreezeMutationVariables = {
  input: ClearLocationSyncFreezeInput;
};

export type ClearLocationSyncFreezeMutationResponse = {
  clearLocationSyncFreeze: ClearLocationSyncFreezeResult;
};
