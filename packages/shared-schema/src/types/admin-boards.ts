/** Stored board metadata, available only through global-admin operations. */
export type AdminBoard = {
  uuid: string;
  slug: string;
  ownerId: string | null;
  ownerDisplayName: string | null;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  description: string | null;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  isPublic: boolean;
  isUnlisted: boolean;
  hideLocation: boolean;
  isOwned: boolean;
  angle: number;
  isAngleAdjustable: boolean;
  hasLeds: boolean;
  serialNumber: string | null;
  timerName: string | null;
  createdAt: string;
  updatedAt: string;
  gymUuid: string | null;
  gymName: string | null;
  gymSlug: string | null;
  canEdit: boolean;
};

export type AdminBoardConnection = {
  boards: AdminBoard[];
  totalCount: number;
  hasMore: boolean;
};

export type AdminBoardsInput = {
  query?: string;
  boardType?: string;
  limit?: number;
  offset?: number;
};
