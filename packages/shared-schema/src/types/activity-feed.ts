// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import type { BetaLinksGqlRow } from '../beta-video-url';

// Activity feed types

import type { SocialEntityType } from './comments';

/**
 * The board configuration a logged climb should be drawn on (GraphQL
 * `RenderBoardConfig`). Resolved server-side against the climber's own boards —
 * see `resolveRenderBoard` in `@boardsesh/board-config` for the ladder. Null on
 * payloads that don't resolve it; clients then fall back to the layout default.
 */
export type RenderBoardConfig = {
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

export type FollowingAscentFeedItem = {
  uuid: string;
  userId: string;
  userDisplayName?: string;
  userAvatarUrl?: string;
  climbUuid: string;
  climbName: string;
  setterUsername?: string;
  boardType: string;
  layoutId?: number;
  angle: number;
  isMirror: boolean;
  status: string;
  attemptCount: number;
  quality?: number;
  difficulty?: number;
  difficultyName?: string;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment: string;
  climbedAt: string;
  frames?: string;
  // Populated only by resolvers that join vote_counts / count comments
  // (e.g. followingClimbAscents). Null for adapter paths and for the
  // paginated followingAscentsFeed / globalAscentsFeed endpoints.
  upvotes?: number | null;
  downvotes?: number | null;
  commentCount?: number | null;
};

export type AscentFeedItem = {
  uuid: string;
  climbUuid: string;
  climbName: string;
  setterUsername?: string | null;
  boardType: string;
  boardId?: number | null;
  boardDisplayName?: string | null;
  layoutId?: number | null;
  renderBoard?: RenderBoardConfig | null;
  angle: number;
  isMirror: boolean;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  quality?: number | null;
  // COALESCE(quality, the climber's own synced star rating from
  // board_climb_ratings). What star displays should read. 1-5 native (no
  // rescaling); null when neither exists.
  effectiveQuality?: number | null;
  difficulty?: number | null;
  difficultyName?: string | null;
  consensusDifficulty?: number | null;
  consensusDifficultyName?: string | null;
  // Boardsesh grade (COALESCE(universal, local)) + confidence tier for this
  // ascent's climb at its angle. Null when no grade row exists; the UI keeps the
  // legacy consensus when boardseshDifficulty is null or confidence is 'setter_only'.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
  qualityAverage?: number | null;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment: string;
  climbedAt: string;
  frames?: string | null;
};

export type AscentFeedInput = {
  limit?: number;
  offset?: number;
  boardType?: string;
  layoutIds?: number[];
  status?: 'flash' | 'send' | 'attempt';
  statusMode?: 'both' | 'send' | 'attempt';
  flashOnly?: boolean;
  climbName?: string;
  minDifficulty?: number;
  maxDifficulty?: number;
  minAngle?: number;
  maxAngle?: number;
  benchmarkOnly?: boolean;
  sortBy?:
    | 'recent'
    | 'hardest'
    | 'easiest'
    | 'mostAttempts'
    | 'climbName'
    | 'loggedGrade'
    | 'consensusGrade'
    | 'date'
    | 'attemptCount';
  sortOrder?: 'asc' | 'desc';
  secondarySortBy?: 'climbName' | 'loggedGrade' | 'consensusGrade' | 'date' | 'attemptCount';
  secondarySortOrder?: 'asc' | 'desc';
  fromDate?: string;
  toDate?: string;
};

export type FollowingAscentsFeedResult = {
  items: FollowingAscentFeedItem[];
  totalCount: number;
  hasMore: boolean;
};

export type FollowingClimbAscentsInput = {
  boardType: string;
  climbUuid: string;
};

export type FollowingClimbAscentsResult = {
  items: FollowingAscentFeedItem[];
};

export type ActivityFeedItemType = 'ascent' | 'new_climb' | 'comment' | 'proposal_approved' | 'session_summary';

export type ActivityFeedItem = {
  id: string;
  type: ActivityFeedItemType;
  entityType: SocialEntityType;
  entityId: string;
  boardUuid?: string | null;
  actorId?: string | null;
  actorDisplayName?: string | null;
  actorAvatarUrl?: string | null;
  climbName?: string | null;
  climbUuid?: string | null;
  boardType?: string | null;
  layoutId?: number | null;
  gradeName?: string | null;
  status?: string | null;
  angle?: number | null;
  frames?: string | null;
  setterUsername?: string | null;
  commentBody?: string | null;
  isMirror?: boolean | null;
  isBenchmark?: boolean | null;
  isNoMatch?: boolean | null;
  difficulty?: number | null;
  difficultyName?: string | null;
  quality?: number | null;
  attemptCount?: number | null;
  comment?: string | null;
  commentCount?: number | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

export type ActivityFeedResult = {
  items: ActivityFeedItem[];
  cursor?: string | null;
  hasMore: boolean;
};

export type ActivityFeedInput = {
  cursor?: string | null;
  limit?: number;
  boardUuid?: string | null;
  userId?: string | null;
  followingOnly?: boolean | null;
  includeDailyHighlights?: boolean | null;
};

export type GlobalCommentFeedInput = {
  cursor?: string | null;
  limit?: number;
  boardUuid?: string | null;
};

// Session-Grouped Feed Types

export type SessionFeedParticipant = {
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  sends: number;
  flashes: number;
  attempts: number;
};

export type SessionGradeDistributionItem = {
  grade: string;
  flash: number;
  send: number;
  attempt: number;
};

export type SessionFeedTickHighlight = {
  uuid: string;
  userId: string;
  climbUuid: string;
  climbName?: string | null;
  boardType: string;
  layoutId?: number | null;
  renderBoard?: RenderBoardConfig | null;
  angle: number;
  status: string;
  attemptCount: number;
  difficulty?: number | null;
  difficultyName?: string | null;
  // Boardsesh grade (COALESCE(universal, local)) + confidence tier for this
  // tick's climb at its angle. Null when no grade row exists.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
  quality?: number | null;
  isMirror: boolean;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment?: string | null;
  frames?: string | null;
  setterUsername?: string | null;
  climbedAt: string;
};

export type SessionFeedBetaHighlight = {
  tick: SessionFeedTickHighlight;
  betaLink: BetaLinksGqlRow;
};

export type SessionFeedItem = {
  sessionId: string;
  sessionType: 'party' | 'daily_highlight';
  sessionName?: string | null;
  ownerUserId?: string | null;
  participants: SessionFeedParticipant[];
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
  gradeDistribution: SessionGradeDistributionItem[];
  boardTypes: string[];
  hardestGrade?: string | null;
  hardestSend?: SessionFeedTickHighlight | null;
  featuredBeta?: SessionFeedBetaHighlight | null;
  socialEntityType: 'session' | 'tick';
  socialEntityId: string;
  firstTickAt: string;
  lastTickAt: string;
  durationMinutes?: number | null;
  goal?: string | null;
  notes?: string | null;
  upvotes: number;
  downvotes: number;
  voteScore: number;
  commentCount: number;
};

export type SessionFeedResult = {
  sessions: SessionFeedItem[];
  cursor?: string | null;
  hasMore: boolean;
};

export type SessionDetailTick = {
  uuid: string;
  userId: string;
  climbUuid: string;
  climbName?: string | null;
  boardType: string;
  layoutId?: number | null;
  renderBoard?: RenderBoardConfig | null;
  angle: number;
  status: string;
  attemptCount: number;
  difficulty?: number | null;
  difficultyName?: string | null;
  // Boardsesh grade (COALESCE(universal, local)) + confidence tier for this
  // tick's climb at its angle. Null when no grade row exists.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
  quality?: number | null;
  isMirror: boolean;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment?: string | null;
  frames?: string | null;
  setterUsername?: string | null;
  climbedAt: string;
  upvotes: number;
  totalAttempts?: number | null;
  // Populated by the session-detail query (always an array there); absent on
  // other selection sets that reuse this type, e.g. the live SessionStatsUpdated
  // subscription. Consumers default to [] when reading it.
  betaLinks?: BetaLinksGqlRow[] | null;
};

export type SessionDetail = {
  sessionId: string;
  sessionType: 'party' | 'daily_highlight';
  sessionName?: string | null;
  ownerUserId?: string | null;
  participants: SessionFeedParticipant[];
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
  gradeDistribution: SessionGradeDistributionItem[];
  boardTypes: string[];
  hardestGrade?: string | null;
  firstTickAt: string;
  lastTickAt: string;
  durationMinutes?: number | null;
  goal?: string | null;
  notes?: string | null;
  ticks: SessionDetailTick[];
  upvotes: number;
  downvotes: number;
  voteScore: number;
  commentCount: number;
  healthKitWorkoutId?: string | null;
};

export type SessionLiveStats = {
  sessionId: string;
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
  participants: SessionFeedParticipant[];
  gradeDistribution: SessionGradeDistributionItem[];
  boardTypes: string[];
  hardestGrade?: string | null;
  durationMinutes?: number | null;
  goal?: string | null;
  ticks: SessionDetailTick[];
};
