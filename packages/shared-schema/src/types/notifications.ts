// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Notification types

import type { SocialEntityType } from './comments';

export type NotificationType =
  | 'new_follower'
  | 'comment_reply'
  | 'comment_on_tick'
  | 'comment_on_climb'
  | 'vote_on_tick'
  | 'vote_on_comment'
  | 'new_climb'
  | 'new_climb_global'
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'proposal_vote'
  | 'proposal_created'
  | 'new_climbs_synced'
  | 'gym_claim_approved';

export type Notification = {
  uuid: string;
  type: NotificationType;
  actorId?: string | null;
  actorDisplayName?: string | null;
  actorAvatarUrl?: string | null;
  entityType?: SocialEntityType | null;
  entityId?: string | null;
  commentBody?: string | null;
  climbName?: string | null;
  climbUuid?: string | null;
  boardType?: string | null;
  proposalUuid?: string | null;
  /** Gym name (for gym_claim_approved notifications). */
  gymName?: string | null;
  isRead: boolean;
  createdAt: string;
};

export type NotificationConnection = {
  notifications: Notification[];
  totalCount: number;
  unreadCount: number;
  hasMore: boolean;
};

export type GroupedNotificationActor = {
  id: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

export type GroupedNotification = {
  uuid: string;
  type: NotificationType;
  entityType?: SocialEntityType | null;
  entityId?: string | null;
  actorCount: number;
  actors: GroupedNotificationActor[];
  commentBody?: string | null;
  climbName?: string | null;
  climbUuid?: string | null;
  boardType?: string | null;
  /** Layout the climb was set on — clients need it to build a resolvable board URL. */
  climbLayoutId?: number | null;
  /** Angle the climb was set at, when the setter fixed one (often null). */
  climbAngle?: number | null;
  proposalUuid?: string | null;
  setterUsername?: string | null;
  /** Gym name (for gym_claim_approved notifications). */
  gymName?: string | null;
  isRead: boolean;
  createdAt: string;
};

export type GroupedNotificationConnection = {
  groups: GroupedNotification[];
  totalCount: number;
  unreadCount: number;
  hasMore: boolean;
};

export type NotificationEvent = {
  notification: Notification;
};
