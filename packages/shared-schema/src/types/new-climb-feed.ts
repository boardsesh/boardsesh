// New Climb Feed & Subscriptions

export type NewClimbSubscription = {
  id: string;
  boardType: string;
  layoutId: number;
  createdAt: string;
};

export type NewClimbSubscriptionInput = {
  boardType: string;
  layoutId: number;
};

export type NewClimbFeedItem = {
  uuid: string;
  name?: string | null;
  boardType: string;
  layoutId: number;
  setterDisplayName?: string | null;
  setterAvatarUrl?: string | null;
  angle?: number | null;
  frames?: string | null;
  difficultyName?: string | null;
  isNoMatch: boolean;
  createdAt: string;
};

export type NewClimbFeedResult = {
  items: NewClimbFeedItem[];
  totalCount: number;
  hasMore: boolean;
};

export type NewClimbFeedInput = {
  boardType: string;
  layoutId: number;
  limit?: number;
  offset?: number;
};

export type NewClimbCreatedEvent = {
  climb: NewClimbFeedItem;
};

export type MoonBoardHoldsInput = {
  start: string[];
  hand: string[];
  finish: string[];
};

export type MoonBoardClimbDuplicateCandidateInput = {
  clientKey: string;
  holds: MoonBoardHoldsInput;
};

export type CheckMoonBoardClimbDuplicatesInput = {
  layoutId: number;
  angle: number;
  climbs: MoonBoardClimbDuplicateCandidateInput[];
};

export type MoonBoardClimbDuplicateMatch = {
  clientKey: string;
  exists: boolean;
  existingClimbUuid?: string | null;
  existingClimbName?: string | null;
};

export type SimilarClimbsInput = {
  boardType: string;
  layoutId: number;
  /**
   * Physical board size to scope candidates to. Load-bearing on Woods, where the
   * 8x10 and 12x12 walls reuse the same hold-id range for different holds, so an
   * unscoped comparison reports cross-wall coincidences as near-identical climbs.
   * Optional: on Woods the target climb's own `compatible_size_ids` fills it in
   * when a `climbUuid` is given, and it is ignored on every other board.
   */
  sizeId?: number | null;
  threshold?: number | null;
  limit?: number | null;
  excludeClimbUuid?: string | null;
  angle?: number | null;
  climbUuid?: string | null;
  frames?: string | null;
};

export type SimilarClimb = {
  uuid: string;
  name?: string | null;
  setterUsername?: string | null;
  angle?: number | null;
  layoutId: number;
  frames?: string | null;
  difficultyName?: string | null;
  qualityAverage?: number | null;
  ascensionistCount?: number | null;
  compatibleSizeIds: number[];
  characteristics?: string[] | null;
  similarity: number;
  sharedHoldCount: number;
  candidateHoldCount: number;
  targetHoldCount: number;
};
