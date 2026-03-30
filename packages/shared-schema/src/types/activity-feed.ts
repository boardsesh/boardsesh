// Activity feed types

import type { SocialEntityType } from './comments';

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
  comment: string;
  climbedAt: string;
  frames?: string;
};

export type FollowingAscentsFeedResult = {
  items: FollowingAscentFeedItem[];
  totalCount: number;
  hasMore: boolean;
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
  difficulty?: number | null;
  difficultyName?: string | null;
  quality?: number | null;
  attemptCount?: number | null;
  comment?: string | null;
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
  difficulty?: number;
  flash: number;
  send: number;
  attempt: number;
};

export type SessionFeedItem = {
  sessionId: string;
  sessionType: 'party' | 'inferred';
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
  angle: number;
  status: string;
  attemptCount: number;
  difficulty?: number | null;
  difficultyName?: string | null;
  quality?: number | null;
  isMirror: boolean;
  isBenchmark: boolean;
  comment?: string | null;
  frames?: string | null;
  setterUsername?: string | null;
  climbedAt: string;
  upvotes: number;
  totalAttempts?: number | null;
};

export type SessionDetail = {
  sessionId: string;
  sessionType: 'party' | 'inferred';
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
  ticks: SessionDetailTick[];
  upvotes: number;
  downvotes: number;
  voteScore: number;
  commentCount: number;
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
