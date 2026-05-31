// Tick types (Local Ascent Tracking)

export type TickStatus = 'flash' | 'send' | 'attempt';

export type Tick = {
  uuid: string;
  userId: string;
  boardType: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality: number | null;
  // Raw user grade override; null means "use the climb's consensus grade".
  // See docs/ascents-and-attempts.md.
  difficulty: number | null;
  // COALESCE(difficulty, ROUND(consensus_difficulty)) — what charts, leaderboards,
  // and grade-range filters should bucket on. Null when neither the user nor
  // the climb has a grade yet. Populated by read queries; mutation responses
  // (saveTick / updateTick) don't compute it.
  effectiveDifficulty?: number | null;
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  auroraType: string | null;
  auroraId: string | null;
  auroraSyncedAt: string | null;
  layoutId: number | null;
  boardId?: number | null;
  // Social aggregates are populated only by read queries (the `ticks`
  // resolver joins `vote_counts` and counts `comments`). Mutation resolvers
  // like `saveTick` / `updateTick` don't compute them, so these stay optional
  // at the type level. Client code that reads a tick via a mutation response
  // should default to 0 rather than rely on these being present.
  upvotes?: number | null;
  downvotes?: number | null;
  commentCount?: number | null;
};

export type SaveTickInput = {
  // Optional client-supplied idempotency key for offline replay (Phase 2).
  uuid?: string;
  boardType: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality?: number | null;
  difficulty?: number | null;
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  sessionId?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  videoUrl?: string | null;
};

export type GetTicksInput = {
  boardType: string;
  climbUuids?: string[];
};

export type AttachBetaLinkInput = {
  boardType: string;
  climbUuid: string;
  link: string;
  angle?: number | null;
};
