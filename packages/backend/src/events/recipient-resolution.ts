import { eq, and, sql } from 'drizzle-orm';
import { createRequestDb } from '@boardsesh/db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { NotificationType } from '@boardsesh/db/schema';

const db = createRequestDb();

interface RecipientInfo {
  recipientId: string;
  notificationType: NotificationType;
}

/**
 * Resolve recipients for a comment event.
 * Returns the entity owner and/or parent comment author.
 */
export async function resolveCommentRecipients(
  entityType: string,
  entityId: string,
  parentCommentId?: string,
): Promise<RecipientInfo[]> {
  const recipients: RecipientInfo[] = [];

  // If this is a reply, notify the parent comment author
  if (parentCommentId) {
    const [parentComment] = await db
      .select({ userId: dbSchema.comments.userId })
      .from(dbSchema.comments)
      .where(eq(dbSchema.comments.uuid, parentCommentId))
      .limit(1);

    if (parentComment) {
      recipients.push({
        recipientId: parentComment.userId,
        notificationType: 'comment_reply',
      });
    }
  }

  // Notify the entity owner
  if (entityType === 'tick') {
    const [tick] = await db
      .select({ userId: dbSchema.boardseshTicks.userId })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, entityId))
      .limit(1);

    if (tick) {
      recipients.push({
        recipientId: tick.userId,
        notificationType: 'comment_on_tick',
      });
    }
  }

  // For climb comments, we don't have a single owner to notify
  // (climbs are set by Aurora users, not boardsesh users)

  // Deduplicate: if the parent comment author IS the tick owner, only send one notification
  const seen = new Set<string>();
  return recipients.filter((r) => {
    if (seen.has(r.recipientId)) return false;
    seen.add(r.recipientId);
    return true;
  });
}

/**
 * Resolve recipients for a vote event.
 */
export async function resolveVoteRecipients(
  entityType: string,
  entityId: string,
): Promise<RecipientInfo[]> {
  if (entityType === 'tick') {
    const [tick] = await db
      .select({ userId: dbSchema.boardseshTicks.userId })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, entityId))
      .limit(1);

    if (tick) {
      return [{
        recipientId: tick.userId,
        notificationType: 'vote_on_tick',
      }];
    }
  }

  if (entityType === 'comment') {
    const [comment] = await db
      .select({ userId: dbSchema.comments.userId })
      .from(dbSchema.comments)
      .where(eq(dbSchema.comments.uuid, entityId))
      .limit(1);

    if (comment) {
      return [{
        recipientId: comment.userId,
        notificationType: 'vote_on_comment',
      }];
    }
  }

  return [];
}

/**
 * Resolve recipients for a proposal vote event.
 * Notifies the proposer.
 */
export async function resolveProposalVoteRecipients(
  proposalUuid: string,
): Promise<RecipientInfo[]> {
  const [proposal] = await db
    .select({ proposerId: dbSchema.climbProposals.proposerId })
    .from(dbSchema.climbProposals)
    .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
    .limit(1);

  if (!proposal) return [];

  return [{
    recipientId: proposal.proposerId,
    notificationType: 'proposal_vote',
  }];
}

/**
 * Resolve recipients for a proposal approval event.
 * Notifies the proposer and all upvoters.
 */
export async function resolveProposalApprovalRecipients(
  proposalUuid: string,
): Promise<RecipientInfo[]> {
  const [proposal] = await db
    .select({
      id: dbSchema.climbProposals.id,
      proposerId: dbSchema.climbProposals.proposerId,
    })
    .from(dbSchema.climbProposals)
    .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
    .limit(1);

  if (!proposal) return [];

  const recipients: RecipientInfo[] = [{
    recipientId: proposal.proposerId,
    notificationType: 'proposal_approved',
  }];

  // Also notify upvoters
  const upvoters = await db
    .select({ userId: dbSchema.proposalVotes.userId })
    .from(dbSchema.proposalVotes)
    .where(
      and(
        eq(dbSchema.proposalVotes.proposalId, proposal.id),
        eq(dbSchema.proposalVotes.value, 1),
      ),
    );

  const seen = new Set<string>([proposal.proposerId]);
  for (const v of upvoters) {
    if (!seen.has(v.userId)) {
      seen.add(v.userId);
      recipients.push({
        recipientId: v.userId,
        notificationType: 'proposal_approved',
      });
    }
  }

  return recipients;
}

/**
 * Resolve recipients for a proposal rejection event.
 * Notifies the proposer.
 */
export async function resolveProposalRejectionRecipients(
  proposalUuid: string,
): Promise<RecipientInfo[]> {
  const [proposal] = await db
    .select({ proposerId: dbSchema.climbProposals.proposerId })
    .from(dbSchema.climbProposals)
    .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
    .limit(1);

  if (!proposal) return [];

  return [{
    recipientId: proposal.proposerId,
    notificationType: 'proposal_rejected',
  }];
}

/**
 * Resolve recipients for a proposal.created event.
 * Notifies users who have logged ascents or attempts on the climb.
 */
export async function resolveProposalCreatedRecipients(
  climbUuid: string,
  boardType: string,
  actorId: string,
): Promise<RecipientInfo[]> {
  const climbers = await db
    .select({ userId: dbSchema.boardseshTicks.userId })
    .from(dbSchema.boardseshTicks)
    .where(
      and(
        eq(dbSchema.boardseshTicks.climbUuid, climbUuid),
        eq(dbSchema.boardseshTicks.boardType, boardType),
      ),
    )
    .groupBy(dbSchema.boardseshTicks.userId);

  return climbers
    .filter((c) => c.userId !== actorId)
    .map((c) => ({
      recipientId: c.userId,
      notificationType: 'proposal_created' as NotificationType,
    }));
}

/**
 * Resolve recipient for a follow event.
 */
export function resolveFollowRecipient(
  metadata: Record<string, string>,
): RecipientInfo | null {
  const followedUserId = metadata.followedUserId;
  if (!followedUserId) return null;

  return {
    recipientId: followedUserId,
    notificationType: 'new_follower',
  };
}

/**
 * Resolve recipients when a user creates a climb: all followers of the setter.
 */
export async function resolveClimbCreatedFollowerRecipients(
  setterId: string,
): Promise<RecipientInfo[]> {
  const followers = await db
    .select({ followerId: dbSchema.userFollows.followerId })
    .from(dbSchema.userFollows)
    .where(eq(dbSchema.userFollows.followingId, setterId));

  return followers.map((f) => ({
    recipientId: f.followerId,
    notificationType: 'new_climb',
  }));
}

/**
 * Resolve recipients subscribed to a board type + layout for new climb notifications.
 */
export async function resolveClimbCreatedSubscriptionRecipients(
  boardType: string,
  layoutId: number,
  excludeUserId?: string,
): Promise<RecipientInfo[]> {
  const rows = await db
    .select({ userId: dbSchema.newClimbSubscriptions.userId })
    .from(dbSchema.newClimbSubscriptions)
    .where(
      and(
        eq(dbSchema.newClimbSubscriptions.boardType, boardType),
        eq(dbSchema.newClimbSubscriptions.layoutId, layoutId),
      ),
    );

  return rows
    .filter((r) => r.userId !== excludeUserId)
    .map((r) => ({
      recipientId: r.userId,
      notificationType: 'new_climb_global',
    }));
}
