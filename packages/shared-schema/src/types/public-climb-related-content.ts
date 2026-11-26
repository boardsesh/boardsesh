import type { BetaLinksGqlRow } from '../beta-video-url';
import type { SimilarClimb } from './new-climb-feed';

export type PublicClimbRelatedContentInput = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  angle: number;
  climbUuid: string;
  includeNearby?: boolean | null;
};

export type PublicClimbSectionStatus = 'loaded' | 'unavailable';

export type PublicClimbRelatedContent = {
  similarStatus: PublicClimbSectionStatus;
  similarClimbs: SimilarClimb[];
  nearbyStatus: PublicClimbSectionStatus | null;
  nearbyClimbs: SimilarClimb[];
  nearbyGrade: string | null;
  betaStatus: PublicClimbSectionStatus;
  betaHasMore: boolean;
  betaLinks: BetaLinksGqlRow[];
};
