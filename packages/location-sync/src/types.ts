export type BoardInstallConfig = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isAngleAdjustable: boolean;
};

export type PublicBoardLocationInput = BoardInstallConfig & {
  sourceKey: string;
  gymSourceKey: string;
  name: string;
  slugBase: string;
  locationName: string | null;
  latitude: number;
  longitude: number;
  gymName: string;
  gymAddress: string | null;
  serialNumber?: string | null;
};

export type SkippedLocationRecord = {
  sourceKey: string;
  reason: string;
};

export type LocationSyncSummary = {
  boardsSeen: number;
  boardsUpserted: number;
  boardsSkipped: number;
  gymsSeen: number;
  gymsUpserted: number;
  skipped: SkippedLocationRecord[];
};
