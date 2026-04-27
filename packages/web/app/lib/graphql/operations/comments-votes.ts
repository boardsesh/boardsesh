import { gql } from 'graphql-request';
import type {
  Comment,
  CommentConnection,
  VoteSummary,
  SocialEntityType,
  SortMode,
  TimePeriod,
} from '@boardsesh/shared-schema';

// ============================================
// Comment Queries
// ============================================

export const GET_GLOBAL_COMMENT_FEED = gql`
  query GetGlobalCommentFeed($input: GlobalCommentFeedInput) {
    globalCommentFeed(input: $input) {
      comments {
        uuid
        userId
        userDisplayName
        userAvatarUrl
        entityType
        entityId
        parentCommentUuid
        body
        isPublic
        isDeleted
        replyCount
        upvotes
        downvotes
        voteScore
        userVote
        createdAt
        updatedAt
      }
      totalCount
      hasMore
      cursor
    }
  }
`;

export const GET_COMMENTS = gql`
  query GetComments($input: CommentsInput!) {
    comments(input: $input) {
      comments {
        uuid
        userId
        userDisplayName
        userAvatarUrl
        entityType
        entityId
        parentCommentUuid
        body
        isPublic
        isDeleted
        replyCount
        upvotes
        downvotes
        voteScore
        userVote
        createdAt
        updatedAt
      }
      totalCount
      hasMore
    }
  }
`;

// ============================================
// Vote Queries
// ============================================

export const GET_VOTE_SUMMARY = gql`
  query GetVoteSummary($entityType: SocialEntityType!, $entityId: String!) {
    voteSummary(entityType: $entityType, entityId: $entityId) {
      entityType
      entityId
      upvotes
      downvotes
      voteScore
      userVote
    }
  }
`;

export const GET_BULK_VOTE_SUMMARIES = gql`
  query GetBulkVoteSummaries($input: BulkVoteSummaryInput!) {
    bulkVoteSummaries(input: $input) {
      entityType
      entityId
      upvotes
      downvotes
      voteScore
      userVote
    }
  }
`;

// ============================================
// Comment Mutations
// ============================================

export const ADD_COMMENT = gql`
  mutation AddComment($input: AddCommentInput!) {
    addComment(input: $input) {
      uuid
      userId
      userDisplayName
      userAvatarUrl
      entityType
      entityId
      parentCommentUuid
      body
      isPublic
      isDeleted
      replyCount
      upvotes
      downvotes
      voteScore
      userVote
      createdAt
      updatedAt
    }
  }
`;

export const UPDATE_COMMENT = gql`
  mutation UpdateComment($input: UpdateCommentInput!) {
    updateComment(input: $input) {
      uuid
      userId
      userDisplayName
      userAvatarUrl
      entityType
      entityId
      parentCommentUuid
      body
      isPublic
      isDeleted
      replyCount
      upvotes
      downvotes
      voteScore
      userVote
      createdAt
      updatedAt
    }
  }
`;

export const DELETE_COMMENT = gql`
  mutation DeleteComment($commentUuid: ID!) {
    deleteComment(commentUuid: $commentUuid)
  }
`;

export const VOTE = gql`
  mutation Vote($input: VoteInput!) {
    vote(input: $input) {
      entityType
      entityId
      upvotes
      downvotes
      voteScore
      userVote
    }
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export interface GetGlobalCommentFeedVariables {
  input?: {
    cursor?: string | null;
    limit?: number;
    boardUuid?: string | null;
  };
}

export interface GetGlobalCommentFeedResponse {
  globalCommentFeed: CommentConnection;
}

export interface GetCommentsQueryVariables {
  input: {
    entityType: SocialEntityType;
    entityId: string;
    parentCommentUuid?: string;
    sortBy?: SortMode;
    timePeriod?: TimePeriod;
    limit?: number;
    offset?: number;
  };
}

export interface GetCommentsQueryResponse {
  comments: CommentConnection;
}

export interface GetVoteSummaryQueryVariables {
  entityType: SocialEntityType;
  entityId: string;
}

export interface GetVoteSummaryQueryResponse {
  voteSummary: VoteSummary;
}

export interface GetBulkVoteSummariesQueryVariables {
  input: {
    entityType: SocialEntityType;
    entityIds: string[];
  };
}

export interface GetBulkVoteSummariesQueryResponse {
  bulkVoteSummaries: VoteSummary[];
}

export interface AddCommentMutationVariables {
  input: {
    entityType: SocialEntityType;
    entityId: string;
    parentCommentUuid?: string;
    body: string;
    isPublic?: boolean;
  };
}

export interface AddCommentMutationResponse {
  addComment: Comment;
}

export interface UpdateCommentMutationVariables {
  input: {
    commentUuid: string;
    body: string;
  };
}

export interface UpdateCommentMutationResponse {
  updateComment: Comment;
}

export interface DeleteCommentMutationVariables {
  commentUuid: string;
}

export interface DeleteCommentMutationResponse {
  deleteComment: boolean;
}

export interface VoteMutationVariables {
  input: {
    entityType: SocialEntityType;
    entityId: string;
    value: number;
  };
}

export interface VoteMutationResponse {
  vote: VoteSummary;
}
