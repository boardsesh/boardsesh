import type { SocialEvent, NotificationType } from '@boardsesh/shared-schema';
import { EventBroker } from './event-broker';
import { pubsub } from '../pubsub/index';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import {
  fanoutCommentFeedItems,
  fanoutFeedItems,
  fanoutNewClimbFeedItems,
  fanoutProposalApprovedFeedItems,
} from './feed-fanout';
import crypto from 'crypto';
import {
  resolveClimbCreatedFollowerRecipients,
  resolveClimbCreatedSubscriptionRecipients,
} from './recipient-resolution';
import { isNoMatchClimb } from '../graphql/resolvers/shared/helpers';
import { logger } from '../utils/logger';

export const eventBroker = new EventBroker();

/**
 * Publish a social event. If the EventBroker is initialized (Redis mode),
 * publishes to Redis Streams. Otherwise falls back to inline notification creation.
 */
export async function publishSocialEvent(event: SocialEvent): Promise<void> {
  if (eventBroker.isInitialized()) {
    await eventBroker.publish(event);
  } else {
    // Fallback: inline notification for local-only mode
    await createInlineNotification(event);
  }
}

/**
 * Inline notification creation for when Redis Streams is not available.
 * Handles the most common event types directly.
 */
async function createInlineNotification(event: SocialEvent): Promise<void> {
  try {
    await fanoutInlineActivity(event);

    let recipientId: string | null = null;
    let notificationType: dbSchema.NotificationType | null = null;

    switch (event.type) {
      case 'follow.created': {
        recipientId = event.metadata.followedUserId;
        notificationType = 'new_follower';
        break;
      }
      case 'comment.created': {
        if (event.entityType === 'tick') {
          const [tick] = await db
            .select({ userId: dbSchema.boardseshTicks.userId })
            .from(dbSchema.boardseshTicks)
            .where(eq(dbSchema.boardseshTicks.uuid, event.entityId))
            .limit(1);
          if (tick) {
            recipientId = tick.userId;
            notificationType = 'comment_on_tick';
          }
        }
        break;
      }
      case 'comment.reply': {
        if (event.metadata.parentCommentId) {
          const [parent] = await db
            .select({ userId: dbSchema.comments.userId })
            .from(dbSchema.comments)
            .where(eq(dbSchema.comments.uuid, event.metadata.parentCommentId))
            .limit(1);
          if (parent) {
            recipientId = parent.userId;
            notificationType = 'comment_reply';
          }
        }
        break;
      }
      case 'proposal.voted': {
        // Notify proposer about the vote
        const [votedProposal] = await db
          .select({ proposerId: dbSchema.climbProposals.proposerId })
          .from(dbSchema.climbProposals)
          .where(eq(dbSchema.climbProposals.uuid, event.entityId))
          .limit(1);
        if (votedProposal) {
          recipientId = votedProposal.proposerId;
          notificationType = 'proposal_vote';
        }
        break;
      }
      case 'proposal.approved': {
        const [approvedProposal] = await db
          .select({ proposerId: dbSchema.climbProposals.proposerId })
          .from(dbSchema.climbProposals)
          .where(eq(dbSchema.climbProposals.uuid, event.entityId))
          .limit(1);
        if (approvedProposal) {
          recipientId = approvedProposal.proposerId;
          notificationType = 'proposal_approved';
        }
        break;
      }
      case 'proposal.rejected': {
        const [rejectedProposal] = await db
          .select({ proposerId: dbSchema.climbProposals.proposerId })
          .from(dbSchema.climbProposals)
          .where(eq(dbSchema.climbProposals.uuid, event.entityId))
          .limit(1);
        if (rejectedProposal) {
          recipientId = rejectedProposal.proposerId;
          notificationType = 'proposal_rejected';
        }
        break;
      }
      case 'vote.cast': {
        if (event.entityType === 'tick') {
          const [tick] = await db
            .select({ userId: dbSchema.boardseshTicks.userId })
            .from(dbSchema.boardseshTicks)
            .where(eq(dbSchema.boardseshTicks.uuid, event.entityId))
            .limit(1);
          if (tick) {
            recipientId = tick.userId;
            notificationType = 'vote_on_tick';
          }
        } else if (event.entityType === 'comment') {
          const [comment] = await db
            .select({ userId: dbSchema.comments.userId })
            .from(dbSchema.comments)
            .where(eq(dbSchema.comments.uuid, event.entityId))
            .limit(1);
          if (comment) {
            recipientId = comment.userId;
            notificationType = 'vote_on_comment';
          }
        }
        break;
      }
      case 'proposal.created': {
        // Multi-recipient notification (all climbers) — handled by NotificationWorker only
        return;
      }
      case 'climb.created': {
        const boardType = event.metadata.boardType;
        const layoutId = parseInt(event.metadata.layoutId || '0', 10);
        if (!boardType || !layoutId) return;

        const [climb] = await db
          .select({
            uuid: dbSchema.boardClimbs.uuid,
            name: dbSchema.boardClimbs.name,
            description: dbSchema.boardClimbs.description,
            layoutId: dbSchema.boardClimbs.layoutId,
            angle: dbSchema.boardClimbs.angle,
            frames: dbSchema.boardClimbs.frames,
            createdAt: dbSchema.boardClimbs.createdAt,
            isDraft: dbSchema.boardClimbs.isDraft,
            isListed: dbSchema.boardClimbs.isListed,
            setterDisplayName: dbSchema.userProfiles.displayName,
            setterAvatarUrl: dbSchema.userProfiles.avatarUrl,
            difficultyName: dbSchema.boardDifficultyGrades.boulderName,
          })
          .from(dbSchema.boardClimbs)
          .leftJoin(dbSchema.users, eq(dbSchema.boardClimbs.userId, dbSchema.users.id))
          .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
          .leftJoin(
            dbSchema.boardClimbStats,
            and(
              eq(dbSchema.boardClimbStats.boardType, dbSchema.boardClimbs.boardType),
              eq(dbSchema.boardClimbStats.climbUuid, dbSchema.boardClimbs.uuid),
              eq(dbSchema.boardClimbStats.angle, dbSchema.boardClimbs.angle),
            ),
          )
          .leftJoin(
            dbSchema.boardDifficultyGrades,
            and(
              eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardClimbs.boardType),
              eq(dbSchema.boardDifficultyGrades.difficulty, dbSchema.boardClimbStats.displayDifficulty),
            ),
          )
          .where(and(eq(dbSchema.boardClimbs.uuid, event.entityId), eq(dbSchema.boardClimbs.boardType, boardType)))
          .limit(1);

        if (!climb || climb.isDraft === true || climb.isListed === false) return;

        const followerRecipients = await resolveClimbCreatedFollowerRecipients(event.actorId);
        const subscriberRecipients = await resolveClimbCreatedSubscriptionRecipients(
          boardType,
          layoutId,
          event.actorId,
        );
        const followerIds = new Set(followerRecipients.map((r) => r.recipientId));
        const recipients = [
          ...followerRecipients,
          ...subscriberRecipients.filter((r) => !followerIds.has(r.recipientId)),
        ].filter((r) => r.recipientId !== event.actorId);

        if (recipients.length === 0) {
          await fanoutNewClimbFeedItems(event);
          return;
        }

        const actorRows = await db
          .select({
            name: dbSchema.users.name,
            image: dbSchema.users.image,
            displayName: dbSchema.userProfiles.displayName,
            avatarUrl: dbSchema.userProfiles.avatarUrl,
          })
          .from(dbSchema.users)
          .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
          .where(eq(dbSchema.users.id, event.actorId))
          .limit(1);
        const actor = actorRows[0];

        for (const recipient of recipients) {
          const uuid = crypto.randomUUID();
          await db.insert(dbSchema.notifications).values({
            uuid,
            recipientId: recipient.recipientId,
            actorId: event.actorId,
            type: recipient.notificationType,
            entityType: 'climb',
            entityId: event.entityId,
          });

          pubsub.publishNotificationEvent(recipient.recipientId, {
            notification: {
              uuid,
              type: recipient.notificationType as NotificationType,
              actorId: event.actorId,
              actorDisplayName: actor?.displayName || actor?.name || undefined,
              actorAvatarUrl: actor?.avatarUrl || actor?.image || undefined,
              entityType: 'climb',
              entityId: event.entityId,
              climbName: event.metadata.climbName || undefined,
              climbUuid: event.entityId,
              boardType,
              isRead: false,
              createdAt: new Date().toISOString(),
            },
          });
        }

        await fanoutNewClimbFeedItems(event);

        const channelKey = `${boardType}:${climb.layoutId}`;
        pubsub.publishNewClimbEvent(channelKey, {
          climb: {
            uuid: climb.uuid,
            name: climb.name ?? event.metadata.climbName,
            boardType,
            layoutId: climb.layoutId,
            setterDisplayName: climb.setterDisplayName ?? actor?.displayName ?? actor?.name ?? undefined,
            setterAvatarUrl: climb.setterAvatarUrl ?? actor?.avatarUrl ?? actor?.image ?? undefined,
            angle: climb.angle ?? null,
            frames: climb.frames ?? null,
            difficultyName: climb.difficultyName ?? event.metadata.difficultyName ?? null,
            isNoMatch: isNoMatchClimb(climb.description),
            createdAt: climb.createdAt ?? new Date().toISOString(),
          },
        });
        return;
      }
      case 'ascent.logged': {
        await fanoutFeedItems(event);
        // No notification for ascent.logged - it's feed-only
        return;
      }
    }

    if (!recipientId || !notificationType || recipientId === event.actorId) return;

    // Deduplicate: check if a similar notification already exists recently
    const [existing] = await db
      .select({ id: dbSchema.notifications.id })
      .from(dbSchema.notifications)
      .where(
        and(
          eq(dbSchema.notifications.actorId, event.actorId),
          eq(dbSchema.notifications.recipientId, recipientId),
          eq(dbSchema.notifications.type, notificationType),
          eq(dbSchema.notifications.entityId, event.entityId),
          sql`${dbSchema.notifications.createdAt} > NOW() - INTERVAL '1 hour'`,
        ),
      )
      .limit(1);
    if (existing) return;

    const uuid = crypto.randomUUID();
    await db.insert(dbSchema.notifications).values({
      uuid,
      recipientId,
      actorId: event.actorId,
      type: notificationType,
      entityType: event.entityType as dbSchema.SocialEntityType,
      entityId: event.entityId,
    });

    // Enrich and push via PubSub
    const [actor] = await db
      .select({
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, event.actorId))
      .limit(1);

    pubsub.publishNotificationEvent(recipientId, {
      notification: {
        uuid,
        type: notificationType as NotificationType,
        actorId: event.actorId,
        actorDisplayName: actor?.displayName || actor?.name || undefined,
        actorAvatarUrl: actor?.avatarUrl || actor?.image || undefined,
        entityType: event.entityType as dbSchema.SocialEntityType,
        entityId: event.entityId,
        isRead: false,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('[Events] Inline notification failed:', error);
  }
}

async function fanoutInlineActivity(event: SocialEvent): Promise<void> {
  try {
    if (event.type === 'comment.created' || event.type === 'comment.reply') {
      await fanoutCommentFeedItems(event);
      return;
    }

    if (event.type === 'proposal.approved') {
      await fanoutProposalApprovedFeedItems(event);
    }
  } catch (error) {
    logger.error('[Events] Inline feed fanout failed:', error);
  }
}

export { EventBroker } from './event-broker';
export { NotificationWorker } from './notification-worker';
