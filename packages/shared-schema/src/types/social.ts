// Social / Follow types

export type PublicUserProfile = {
  id: string;
  displayName?: string;
  avatarUrl?: string;
  instagramUrl?: string | null;
  followerCount: number;
  followingCount: number;
  isFollowedByMe: boolean;
};

export type FollowConnection = {
  users: PublicUserProfile[];
  totalCount: number;
  hasMore: boolean;
};

export type UserSearchResult = {
  user: PublicUserProfile;
  recentAscentCount: number;
  matchReason?: string;
};

export type UserSearchConnection = {
  results: UserSearchResult[];
  totalCount: number;
  hasMore: boolean;
};

// Setter Profile & Search Types

export type SetterProfile = {
  username: string;
  climbCount: number;
  boardTypes: string[];
  followerCount: number;
  isFollowedByMe: boolean;
  linkedUserId?: string | null;
  linkedUserDisplayName?: string | null;
  linkedUserAvatarUrl?: string | null;
};

export type SetterSearchResult = {
  username: string;
  climbCount: number;
  boardTypes: string[];
  isFollowedByMe: boolean;
};

export type UnifiedSearchResult = {
  user?: PublicUserProfile | null;
  setter?: SetterSearchResult | null;
  recentAscentCount: number;
  matchReason?: string;
};

export type UnifiedSearchConnection = {
  results: UnifiedSearchResult[];
  totalCount: number;
  hasMore: boolean;
};

export type SetterClimb = {
  uuid: string;
  name?: string | null;
  boardType: string;
  layoutId: number;
  angle?: number | null;
  difficultyName?: string | null;
  qualityAverage?: number | null;
  ascensionistCount?: number | null;
  createdAt?: string | null;
};

export type SetterClimbsConnection = {
  climbs: SetterClimb[];
  totalCount: number;
  hasMore: boolean;
};

export type FollowSetterInput = {
  setterUsername: string;
};

export type SetterProfileInput = {
  username: string;
};

export type SetterClimbsInput = {
  username: string;
  boardType?: string;
  layoutId?: number;
  sortBy?: 'popular' | 'new';
  limit?: number;
  offset?: number;
};

export type UserClimbsInput = {
  userId: string;
  sortBy?: string;
  limit?: number;
  offset?: number;
};

// Social Event Types (Redis Streams)

export type SocialEventType =
  | 'comment.created'
  | 'comment.reply'
  | 'vote.cast'
  | 'follow.created'
  | 'climb.created'
  | 'ascent.logged'
  | 'proposal.created'
  | 'proposal.voted'
  | 'proposal.approved'
  | 'proposal.rejected'
  | 'proposal.deleted';

export type SocialEvent = {
  type: SocialEventType;
  actorId: string;
  entityType: string;
  entityId: string;
  timestamp: number;
  metadata: Record<string, string>;
};
