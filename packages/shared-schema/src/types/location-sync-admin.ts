// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export type LocationSyncEntityType = 'GYM' | 'BOARD';

export type FrozenLocationSyncEntity = {
  entityType: LocationSyncEntityType;
  entityUuid: string;
  slug?: string | null;
  name: string;
  boardType?: string | null;
  isSystemOwned: boolean;
  /** A separate gym ownership/approved-claim guard still blocks metadata refreshes. */
  ownerProtected: boolean;
  isDeleted: boolean;
  deletedAt?: string | null;
  syncFrozenAt: string;
  /** Known upstream gym aliases. Boards do not currently persist source keys. */
  sourceKeys: string[];
};

export type FrozenLocationSyncEntityConnection = {
  entities: FrozenLocationSyncEntity[];
  totalCount: number;
  hasMore: boolean;
};

export type FrozenLocationSyncEntitiesInput = {
  entityType: LocationSyncEntityType;
  query?: string;
  limit?: number;
  offset?: number;
};

export type ClearLocationSyncFreezeStatus = 'CLEARED' | 'ALREADY_UNFROZEN';

export type ClearLocationSyncFreezeInput = {
  entityType: LocationSyncEntityType;
  entityUuid: string;
  expectedSyncFrozenAt: string;
  reason: string;
};

export type ClearLocationSyncFreezeResult = {
  status: ClearLocationSyncFreezeStatus;
  entityType: LocationSyncEntityType;
  entityUuid: string;
  previousSyncFrozenAt?: string | null;
};
