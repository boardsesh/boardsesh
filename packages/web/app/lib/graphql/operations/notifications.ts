import { gql } from 'graphql-request';
import type {
  Notification,
  NotificationConnection,
  GroupedNotificationConnection,
  NotificationType,
  SocialEntityType,
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
        proposalUuid
        setterUsername
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

export interface GetNotificationsQueryVariables {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface GetNotificationsQueryResponse {
  notifications: NotificationConnection;
}

export interface GetGroupedNotificationsQueryVariables {
  limit?: number;
  offset?: number;
}

export interface GetGroupedNotificationsQueryResponse {
  groupedNotifications: GroupedNotificationConnection;
}

export interface GetUnreadNotificationCountQueryResponse {
  unreadNotificationCount: number;
}

export interface MarkNotificationReadMutationVariables {
  notificationUuid: string;
}

export interface MarkNotificationReadMutationResponse {
  markNotificationRead: boolean;
}

export interface MarkGroupNotificationsReadMutationVariables {
  type: string;
  entityType?: string | null;
  entityId?: string | null;
}

export interface MarkGroupNotificationsReadMutationResponse {
  markGroupNotificationsRead: number;
}

export interface MarkAllNotificationsReadMutationResponse {
  markAllNotificationsRead: boolean;
}

export interface NotificationReceivedSubscriptionResponse {
  notificationReceived: {
    notification: Notification;
  };
}

export interface CommentUpdatesSubscriptionVariables {
  entityType: SocialEntityType;
  entityId: string;
}

export type CommentUpdatesSubscriptionResponse = {
  commentUpdates:
    | { __typename: 'CommentAdded'; comment: import('@boardsesh/shared-schema').Comment }
    | { __typename: 'CommentUpdated'; comment: import('@boardsesh/shared-schema').Comment }
    | { __typename: 'CommentDeleted'; commentUuid: string; entityType: SocialEntityType; entityId: string };
};
