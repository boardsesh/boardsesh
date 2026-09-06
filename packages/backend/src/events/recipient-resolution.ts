import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { NotificationType } from '@boardsesh/db/schema';

export type RecipientInfo = {
  recipientId: string;
  notificationType: NotificationType;
};

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
export async function resolveVoteRecipients(entityType: string, entityId: string): Promise<RecipientInfo[]> {
  if (entityType === 'tick') {
    const [tick] = await db
      .select({ userId: dbSchema.boardseshTicks.userId })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.uuid, entityId))
      .limit(1);

    if (tick) {
      return [
        {
          recipientId: tick.userId,
          notificationType: 'vote_on_tick',
        },
      ];
    }
  }

  if (entityType === 'comment') {
    const [comment] = await db
      .select({ userId: dbSchema.comments.userId })
      .from(dbSchema.comments)
      .where(eq(dbSchema.comments.uuid, entityId))
      .limit(1);

    if (comment) {
      return [
        {
          recipientId: comment.userId,
          notificationType: 'vote_on_comment',
        },
      ];
    }
  }

  return [];
}

/**
 * Resolve recipients for a proposal vote event.
 * Notifies the proposer.
 */
export async function resolveProposalVoteRecipients(proposalUuid: string): Promise<RecipientInfo[]> {
  const [proposal] = await db
    .select({ proposerId: dbSchema.climbProposals.proposerId })
    .from(dbSchema.climbProposals)
    .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
    .limit(1);

  if (!proposal) return [];

  return [
    {
      recipientId: proposal.proposerId,
      notificationType: 'proposal_vote',
    },
  ];
}

/**
 * Resolve recipients for a proposal approval event.
 * Notifies the proposer and all upvoters.
 */
export async function resolveProposalApprovalRecipients(proposalUuid: string): Promise<RecipientInfo[]> {
  const [proposal] = await db
    .select({
      id: dbSchema.climbProposals.id,
      proposerId: dbSchema.climbProposals.proposerId,
    })
    .from(dbSchema.climbProposals)
    .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
    .limit(1);

  if (!proposal) return [];

  const recipients: RecipientInfo[] = [
    {
      recipientId: proposal.proposerId,
      notificationType: 'proposal_approved',
    },
  ];

  // Also notify upvoters
  const upvoters = await db
    .select({ userId: dbSchema.proposalVotes.userId })
    .from(dbSchema.proposalVotes)
    .where(and(eq(dbSchema.proposalVotes.proposalId, proposal.id), eq(dbSchema.proposalVotes.value, 1)));

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
export async function resolveProposalRejectionRecipients(proposalUuid: string): Promise<RecipientInfo[]> {
  const [proposal] = await db
    .select({ proposerId: dbSchema.climbProposals.proposerId })
    .from(dbSchema.climbProposals)
    .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
    .limit(1);

  if (!proposal) return [];

  return [
    {
      recipientId: proposal.proposerId,
      notificationType: 'proposal_rejected',
    },
  ];
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
    .where(and(eq(dbSchema.boardseshTicks.climbUuid, climbUuid), eq(dbSchema.boardseshTicks.boardType, boardType)))
    .groupBy(dbSchema.boardseshTicks.userId);

  return climbers
    .filter((c) => c.userId !== actorId)
    .map((c) => ({
      recipientId: c.userId,
      notificationType: 'proposal_created' as NotificationType,
    }));
}

/**
 * Resolve the setter of a climb as a recipient of `proposal_on_your_climb`.
 *
 * Two ways a climb points at a Boardsesh account, mirroring the setter check in
 * `resolvers/social/proposals/setter-overrides.ts`:
 *
 * 1. Climbs authored on Boardsesh store the Boardsesh user id in
 *    `board_climbs.user_id`.
 * 2. Aurora-synced climbs only carry the Aurora account number in
 *    `board_climbs.setter_id`, so the setter is every Boardsesh account that
 *    has linked that Aurora account for this board type. That is normally one
 *    account, but nothing stops two people linking the same Aurora login, so
 *    this returns a list and de-duplicates it.
 *
 * Both are resolved, not one or the other. `setter-overrides.ts` grants setter
 * powers on either match, so a climb carrying a `user_id` AND a `setter_id` has
 * two people who can act as its setter; telling only the first would leave the
 * other holding the powers while never hearing that the climb was reported.
 *
 * The actor never notifies themselves: reporting your own climb is silent.
 */
export async function resolveClimbSetterRecipients(
  climbUuid: string,
  boardType: string,
  actorId: string,
): Promise<RecipientInfo[]> {
  const [climb] = await db
    .select({
      userId: dbSchema.boardClimbs.userId,
      setterId: dbSchema.boardClimbs.setterId,
    })
    .from(dbSchema.boardClimbs)
    .where(and(eq(dbSchema.boardClimbs.uuid, climbUuid), eq(dbSchema.boardClimbs.boardType, boardType)))
    .limit(1);

  if (!climb) return [];

  const setterUserIds: string[] = [];
  if (climb.userId) setterUserIds.push(climb.userId);

  if (climb.setterId != null) {
    const linkedAccounts = await db
      .select({ userId: dbSchema.auroraCredentials.userId })
      .from(dbSchema.auroraCredentials)
      .where(
        and(
          eq(dbSchema.auroraCredentials.boardType, boardType),
          eq(dbSchema.auroraCredentials.auroraUserId, climb.setterId),
        ),
      );
    for (const account of linkedAccounts) setterUserIds.push(account.userId);
  }

  const seen = new Set<string>();
  const recipients: RecipientInfo[] = [];
  for (const setterUserId of setterUserIds) {
    if (setterUserId === actorId || seen.has(setterUserId)) continue;
    seen.add(setterUserId);
    recipients.push({ recipientId: setterUserId, notificationType: 'proposal_on_your_climb' });
  }
  return recipients;
}

/**
 * Merge the setter recipients with the climbers who ticked the climb.
 *
 * A setter who also ticked their own climb is in both lists. They get the
 * setter notification only — "someone reported your climb" beats "someone
 * proposed a change to a climb you've done".
 */
export function mergeProposalCreatedRecipients(
  setterRecipients: RecipientInfo[],
  tickerRecipients: RecipientInfo[],
): RecipientInfo[] {
  const setterIds = new Set(setterRecipients.map((recipient) => recipient.recipientId));
  return [...setterRecipients, ...tickerRecipients.filter((recipient) => !setterIds.has(recipient.recipientId))];
}

/**
 * Resolve recipient for a follow event.
 */
export function resolveFollowRecipient(metadata: Record<string, string>): RecipientInfo | null {
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
export async function resolveClimbCreatedFollowerRecipients(setterId: string): Promise<RecipientInfo[]> {
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
