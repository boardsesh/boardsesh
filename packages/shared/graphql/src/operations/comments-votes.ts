// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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

export type GetGlobalCommentFeedVariables = {
  input?: {
    cursor?: string | null;
    limit?: number;
    boardUuid?: string | null;
  };
};

export type GetGlobalCommentFeedResponse = {
  globalCommentFeed: CommentConnection;
};

export type GetCommentsQueryVariables = {
  input: {
    entityType: SocialEntityType;
    entityId: string;
    parentCommentUuid?: string;
    sortBy?: SortMode;
    timePeriod?: TimePeriod;
    limit?: number;
    offset?: number;
  };
};

export type GetCommentsQueryResponse = {
  comments: CommentConnection;
};

export type GetVoteSummaryQueryVariables = {
  entityType: SocialEntityType;
  entityId: string;
};

export type GetVoteSummaryQueryResponse = {
  voteSummary: VoteSummary;
};

export type GetBulkVoteSummariesQueryVariables = {
  input: {
    entityType: SocialEntityType;
    entityIds: string[];
  };
};

export type GetBulkVoteSummariesQueryResponse = {
  bulkVoteSummaries: VoteSummary[];
};

export type AddCommentMutationVariables = {
  input: {
    entityType: SocialEntityType;
    entityId: string;
    parentCommentUuid?: string;
    body: string;
  };
};

export type AddCommentMutationResponse = {
  addComment: Comment;
};

export type UpdateCommentMutationVariables = {
  input: {
    commentUuid: string;
    body: string;
  };
};

export type UpdateCommentMutationResponse = {
  updateComment: Comment;
};

export type DeleteCommentMutationVariables = {
  commentUuid: string;
};

export type DeleteCommentMutationResponse = {
  deleteComment: boolean;
};

export type VoteMutationVariables = {
  input: {
    entityType: SocialEntityType;
    entityId: string;
    // The backend rejects anything but +1/-1 (see VoteInputSchema in
    // packages/backend) — narrowed to a literal union so a stray 0/undefined
    // can never type-check onto the wire.
    value: 1 | -1;
  };
};

export type VoteMutationResponse = {
  vote: VoteSummary;
};
