// Board entity types

export type UserBoard = {
  uuid: string;
  slug: string;
  ownerId: string;
  ownerDisplayName?: string;
  ownerAvatarUrl?: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  description?: string | null;
  locationName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic: boolean;
  isUnlisted: boolean;
  hideLocation: boolean;
  isOwned: boolean;
  angle: number;
  isAngleAdjustable: boolean;
  createdAt: string;
  layoutName?: string | null;
  sizeName?: string | null;
  sizeDescription?: string | null;
  setNames?: string[] | null;
  totalAscents: number;
  uniqueClimbers: number;
  followerCount: number;
  commentCount: number;
  isFollowedByMe: boolean;
  gymId?: number | null;
  gymUuid?: string | null;
  gymName?: string | null;
  distanceMeters?: number | null;
  serialNumber?: string | null;
};

export type UserBoardConnection = {
  boards: UserBoard[];
  totalCount: number;
  hasMore: boolean;
};

export type BoardLeaderboardEntry = {
  userId: string;
  userDisplayName?: string;
  userAvatarUrl?: string;
  rank: number;
  totalSends: number;
  totalFlashes: number;
  hardestGrade?: number | null;
  hardestGradeName?: string | null;
  totalSessions: number;
};

export type BoardLeaderboard = {
  boardUuid: string;
  entries: BoardLeaderboardEntry[];
  totalCount: number;
  hasMore: boolean;
  periodLabel: string;
};

export type CreateBoardInput = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  description?: string;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  isOwned?: boolean;
  gymUuid?: string;
  angle?: number;
  isAngleAdjustable?: boolean;
  serialNumber?: string;
};

export type UpdateBoardInput = {
  boardUuid: string;
  name?: string;
  slug?: string;
  // Nullable clearable fields: `undefined` leaves the value unchanged, `null`
  // clears it server-side (the resolver applies any value that isn't undefined,
  // and the Zod schema accepts null). The edit form sends null for an emptied
  // field that previously had a value.
  description?: string | null;
  locationName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  isUnlisted?: boolean;
  hideLocation?: boolean;
  isOwned?: boolean;
  angle?: number;
  isAngleAdjustable?: boolean;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  serialNumber?: string | null;
};

export type BoardLeaderboardInput = {
  boardUuid: string;
  period?: string;
  limit?: number;
  offset?: number;
};

export type MyBoardsInput = {
  limit?: number;
  offset?: number;
};

export type FollowBoardInput = {
  boardUuid: string;
};

export type SearchBoardsInput = {
  query?: string;
  boardType?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  limit?: number;
  offset?: number;
};

export type PopularBoardConfig = {
  boardType: string;
  layoutId: number;
  layoutName?: string | null;
  sizeId: number;
  sizeName?: string | null;
  sizeDescription?: string | null;
  setIds: number[];
  setNames: string[];
  climbCount: number;
  totalAscents: number;
  boardCount: number;
  displayName: string;
};

export type PopularBoardConfigConnection = {
  configs: PopularBoardConfig[];
  totalCount: number;
  hasMore: boolean;
};

export type PopularBoardConfigsInput = {
  boardType?: string;
  limit?: number;
  offset?: number;
};
