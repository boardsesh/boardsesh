import { gql } from 'graphql-request';
import type {
  Notification,
  NotificationConnection,
  GroupedNotificationConnection,
  SocialEntityType,
  Comment,
} from '@boardsesh/shared-schema';

// ============================================
// Notification Queries
// ============================================

export const GET_NOTIFICATIONS = gql`
  query GetNotifications($unreadOnly: Boolean, $limit: Int, $offset: Int) {
    notifications(unreadOnly: $unreadOnly, limit: $limit, offset: $offset) {
      notifications {
        uuid
        type
        actorId
        actorDisplayName
        actorAvatarUrl
        entityType
        entityId
        commentBody
        climbName
        climbUuid
        boardType
        proposalUuid
        proposalType
        proposalValue
        isRead
        createdAt
      }
      totalCount
      unreadCount
      hasMore
    }
  }
`;

export const GET_GROUPED_NOTIFICATIONS = gql`
  query GetGroupedNotifications($limit: Int, $offset: Int) {
    groupedNotifications(limit: $limit, offset: $offset) {
      groups {
        uuid
        type
        entityType
        entityId
        actorCount
        actors {
          id
          displayName
          avatarUrl
        }
        commentBody
        climbName
        climbUuid
        boardType
        climbLayoutId
        climbAngle
        proposalUuid
        proposalType
        proposalValue
        setterUsername
        gymName
        isRead
        createdAt
      }
      totalCount
      unreadCount
      hasMore
    }
  }
`;

export const GET_UNREAD_NOTIFICATION_COUNT = gql`
  query GetUnreadNotificationCount {
    unreadNotificationCount
  }
`;

// ============================================
// Notification Mutations
// ============================================

export const MARK_NOTIFICATION_READ = gql`
  mutation MarkNotificationRead($notificationUuid: ID!) {
    markNotificationRead(notificationUuid: $notificationUuid)
  }
`;

export const MARK_GROUP_NOTIFICATIONS_READ = gql`
  mutation MarkGroupNotificationsRead($type: NotificationType!, $entityType: SocialEntityType, $entityId: String) {
    markGroupNotificationsRead(type: $type, entityType: $entityType, entityId: $entityId)
  }
`;

export const MARK_ALL_NOTIFICATIONS_READ = gql`
  mutation MarkAllNotificationsRead {
    markAllNotificationsRead
  }
`;

// ============================================
// Notification Subscription
// ============================================

export const NOTIFICATION_RECEIVED_SUBSCRIPTION = `
  subscription NotificationReceived {
    notificationReceived {
      notification {
        uuid
        type
        actorId
        actorDisplayName
        actorAvatarUrl
        entityType
        entityId
        commentBody
        climbName
        climbUuid
        boardType
        proposalUuid
        proposalType
        proposalValue
        gymName
        isRead
        createdAt
      }
    }
  }
`;

// ============================================
// Comment Updates Subscription
// ============================================

export const COMMENT_UPDATES_SUBSCRIPTION = `
  subscription CommentUpdates($entityType: SocialEntityType!, $entityId: String!) {
    commentUpdates(entityType: $entityType, entityId: $entityId) {
      __typename
      ... on CommentAdded {
        comment {
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
      ... on CommentUpdated {
        comment {
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
      ... on CommentDeleted {
        commentUuid
        entityType
        entityId
      }
    }
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export type GetNotificationsQueryVariables = {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
};

export type GetNotificationsQueryResponse = {
  notifications: NotificationConnection;
};

export type GetGroupedNotificationsQueryVariables = {
  limit?: number;
  offset?: number;
};

export type GetGroupedNotificationsQueryResponse = {
  groupedNotifications: GroupedNotificationConnection;
};

export type GetUnreadNotificationCountQueryResponse = {
  unreadNotificationCount: number;
};

export type MarkNotificationReadMutationVariables = {
  notificationUuid: string;
};

export type MarkNotificationReadMutationResponse = {
  markNotificationRead: boolean;
};

export type MarkGroupNotificationsReadMutationVariables = {
  type: string;
  entityType?: string | null;
  entityId?: string | null;
};

export type MarkGroupNotificationsReadMutationResponse = {
  markGroupNotificationsRead: number;
};

export type MarkAllNotificationsReadMutationResponse = {
  markAllNotificationsRead: boolean;
};

export type NotificationReceivedSubscriptionResponse = {
  notificationReceived: {
    notification: Notification;
  };
};

export type CommentUpdatesSubscriptionVariables = {
  entityType: SocialEntityType;
  entityId: string;
};

export type CommentUpdatesSubscriptionResponse = {
  commentUpdates:
    | { __typename: 'CommentAdded'; comment: Comment }
    | { __typename: 'CommentUpdated'; comment: Comment }
    | {
        __typename: 'CommentDeleted';
        commentUuid: string;
        entityType: SocialEntityType;
        entityId: string;
      };
};
