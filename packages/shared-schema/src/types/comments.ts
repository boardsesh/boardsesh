// Comments & Votes types

export type SocialEntityType =
  | 'playlist_climb'
  | 'climb'
  | 'tick'
  | 'comment'
  | 'proposal'
  | 'board'
  | 'gym'
  | 'session';

export type SortMode = 'new' | 'top' | 'controversial' | 'hot';

export type TimePeriod = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export type Comment = {
  uuid: string;
  userId: string;
  userDisplayName?: string;
  userAvatarUrl?: string;
  entityType: SocialEntityType;
  entityId: string;
  parentCommentUuid?: string | null;
  body: string | null;
  isPublic: boolean;
  isDeleted: boolean;
  replyCount: number;
  upvotes: number;
  downvotes: number;
  voteScore: number;
  userVote: number;
  createdAt: string;
  updatedAt: string;
};

export type CommentConnection = {
  comments: Comment[];
  totalCount: number;
  hasMore: boolean;
  cursor?: string | null;
};

export type VoteSummary = {
  entityType: SocialEntityType;
  entityId: string;
  upvotes: number;
  downvotes: number;
  voteScore: number;
  userVote: number;
};

export type AddCommentInput = {
  entityType: SocialEntityType;
  entityId: string;
  parentCommentUuid?: string;
  body: string;
  isPublic?: boolean;
};

export type UpdateCommentInput = {
  commentUuid: string;
  body: string;
};

export type VoteInput = {
  entityType: SocialEntityType;
  entityId: string;
  value: number;
};

export type CommentsInput = {
  entityType: SocialEntityType;
  entityId: string;
  parentCommentUuid?: string;
  sortBy?: SortMode;
  timePeriod?: TimePeriod;
  limit?: number;
  offset?: number;
};

export type BulkVoteSummaryInput = {
  entityType: SocialEntityType;
  entityIds: string[];
};

export type CommentAdded = {
  __typename: 'CommentAdded';
  comment: Comment;
};

export type CommentUpdated = {
  __typename: 'CommentUpdated';
  comment: Comment;
};

export type CommentDeleted = {
  __typename: 'CommentDeleted';
  commentUuid: string;
  entityType: SocialEntityType;
  entityId: string;
};

export type CommentEvent = CommentAdded | CommentUpdated | CommentDeleted;
