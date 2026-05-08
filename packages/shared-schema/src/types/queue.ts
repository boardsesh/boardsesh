// Queue types

import type { UserId } from './user';
import type { Climb, ClimbInput } from './climb';

export type QueueItemUser = {
  id: string;
  username: string;
  avatarUrl?: string | null; // GraphQL nullable String
};

// Input type for QueueItemUser (matches GraphQL QueueItemUserInput)
export type QueueItemUserInput = {
  id: string;
  username: string;
  avatarUrl?: string | null;
};

export type ClimbQueueItem = {
  uuid: string;
  climb: Climb;
  addedBy?: UserId;
  addedByUser?: QueueItemUser;
  tickedBy?: UserId[];
  suggested?: boolean;
};

// Input type for ClimbQueueItem (matches GraphQL ClimbQueueItemInput)
export type ClimbQueueItemInput = {
  uuid: string;
  climb: ClimbInput;
  addedBy?: string | null;
  addedByUser?: QueueItemUserInput | null;
  tickedBy?: string[] | null;
  suggested?: boolean | null;
};

export type UserPick = {
  userId: UserId;
  item: ClimbQueueItem;
  updatedAt: string;
};

export type BoardSend = {
  id: string;
  sessionId: string;
  item: ClimbQueueItem;
  climbUuid: string;
  sentByUserId: UserId;
  activeClimberUserId: UserId;
  correlationId?: string | null;
  sequence: number;
  createdAt: string;
};

export type QueueState = {
  sequence: number;
  stateHash: string;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  picks?: UserPick[];
  activeClimberUserId?: UserId | null;
};
