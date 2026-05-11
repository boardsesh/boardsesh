import { eq, and, sql } from 'drizzle-orm';
import type { SocialEvent } from '@boardsesh/shared-schema';
import type { NotificationType } from '@boardsesh/db/schema';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../pubsub/index';
import type { EventBroker } from './event-broker';
import {
  resolveCommentRecipients,
  resolveVoteRecipients,
  resolveFollowRecipient,
  resolveProposalVoteRecipients,
  resolveProposalApprovalRecipients,
  resolveProposalRejectionRecipients,
  resolveProposalCreatedRecipients,
  resolveClimbCreatedFollowerRecipients,
  resolveClimbCreatedSubscriptionRecipients,
} from './recipient-resolution';
import { fanoutFeedItems, fanoutNewClimbFeedItems } from './feed-fanout';
import { isNoMatchClimb } from '../graphql/resolvers/shared/helpers';
import crypto from 'crypto';

export class NotificationWorker {
  private eventBroker: EventBroker;

  constructor(eventBroker: EventBroker) {
    this.eventBroker = eventBroker;
  }

  start(): void {
    this.eventBroker.startConsumer(this.processEvent.bind(this));
    console.info('[NotificationWorker] Started');
  }

  private async processEvent(event: SocialEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'comment.created':
          await this.handleCommentCreated(event);
          break;
        case 'comment.reply':
          await this.handleCommentReply(event);
          break;
        case 'vote.cast':
          await this.handleVoteCast(event);
          break;
        case 'follow.created':
          await this.handleFollowCreated(event);
          break;
        case 'ascent.logged':
          await this.handleAscentLogged(event);
          break;
        case 'proposal.voted':
          await this.handleProposalVoted(event);
          break;
        case 'proposal.approved':
          await this.handleProposalApproved(event);
          break;
        case 'proposal.rejected':
          await this.handleProposalRejected(event);
          break;
        case 'proposal.created':
          await this.handleProposalCreated(event);
          break;
        case 'climb.created':
          await this.handleClimbCreated(event);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error(`[NotificationWorker] Error processing event ${event.type}:`, error);
    }
  }

  private async handleCommentCreated(event: SocialEvent): Promise<void> {
    const recipients = await resolveCommentRecipients(event.entityType, event.entityId);

    for (const recipient of recipients) {
      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        event.entityType,
        event.entityId,
        event.metadata.commentUuid,
      );
    }
  }

  private async handleCommentReply(event: SocialEvent): Promise<void> {
    const recipients = await resolveCommentRecipients(event.entityType, event.entityId, event.metadata.parentCommentId);

    for (const recipient of recipients) {
      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        event.entityType,
        event.entityId,
        event.metadata.commentUuid,
      );
    }
  }

  private async handleVoteCast(event: SocialEvent): Promise<void> {
    const recipients = await resolveVoteRecipients(event.entityType, event.entityId);

    for (const recipient of recipients) {
      // Deduplicate: skip if same actor voted on same entity recently (1 hour)
      const isDuplicate = await this.isDuplicate(
        event.actorId,
        recipient.recipientId,
        recipient.notificationType,
        event.entityId,
        60,
      );
      if (isDuplicate) continue;

      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        event.entityType,
        event.entityId,
      );
    }
  }

  private async handleFollowCreated(event: SocialEvent): Promise<void> {
    const recipient = resolveFollowRecipient(event.metadata);
    if (!recipient) return;

    // Deduplicate follows within 24 hours
    const isDuplicate = await this.isDuplicate(
      event.actorId,
      recipient.recipientId,
      recipient.notificationType,
      event.entityId,
      1440,
    );
    if (isDuplicate) return;

    await this.createAndPublishNotification(
      recipient.recipientId,
      event.actorId,
      recipient.notificationType,
      null,
      event.entityId,
    );
  }

  private async handleAscentLogged(event: SocialEvent): Promise<void> {
    await fanoutFeedItems(event);
  }

  private async handleProposalVoted(event: SocialEvent): Promise<void> {
    const recipients = await resolveProposalVoteRecipients(event.entityId);

    for (const recipient of recipients) {
      const isDuplicate = await this.isDuplicate(
        event.actorId,
        recipient.recipientId,
        recipient.notificationType,
        event.entityId,
        60,
      );
      if (isDuplicate) continue;

      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        event.entityType,
        event.entityId,
      );
    }
  }

  private async handleProposalApproved(event: SocialEvent): Promise<void> {
    const recipients = await resolveProposalApprovalRecipients(event.entityId);

    for (const recipient of recipients) {
      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        event.entityType,
        event.entityId,
      );
    }
  }

  private async handleProposalRejected(event: SocialEvent): Promise<void> {
    const recipients = await resolveProposalRejectionRecipients(event.entityId);

    for (const recipient of recipients) {
      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        event.entityType,
        event.entityId,
      );
    }
  }

  private async handleProposalCreated(event: SocialEvent): Promise<void> {
    const climbUuid = event.metadata.climbUuid;
    const boardType = event.metadata.boardType;
    if (!climbUuid || !boardType) return;

    const recipients = await resolveProposalCreatedRecipients(climbUuid, boardType, event.actorId);

    for (const recipient of recipients) {
      const isDuplicate = await this.isDuplicate(
        event.actorId,
        recipient.recipientId,
        recipient.notificationType,
        event.entityId,
        60,
      );
      if (isDuplicate) continue;

      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        event.entityType,
        event.entityId,
      );
    }
  }

  /**
   * Handle climb.created events: notify followers and layout subscribers,
   * fan out feed items, and publish realtime new-climb events.
   */
  private async handleClimbCreated(event: SocialEvent): Promise<void> {
    const boardType = event.metadata.boardType;
    const layoutId = parseInt(event.metadata.layoutId || '0', 10);
    const climbName = event.metadata.climbName || '';

    if (!boardType || !layoutId) return;

    const followerRecipients = await resolveClimbCreatedFollowerRecipients(event.actorId);
    const subscriberRecipients = await resolveClimbCreatedSubscriptionRecipients(boardType, layoutId, event.actorId);

    const followerIds = new Set(followerRecipients.map((r) => r.recipientId));
    const allRecipients = [
      ...followerRecipients,
      ...subscriberRecipients.filter((r) => !followerIds.has(r.recipientId)),
    ];

    for (const recipient of allRecipients) {
      await this.createAndPublishNotification(
        recipient.recipientId,
        event.actorId,
        recipient.notificationType,
        'climb',
        event.entityId,
      );
    }

    // Fan out feed items to followers only (not global subscribers)
    await fanoutNewClimbFeedItems(event);

    // Publish realtime new climb event to the board+layout channel
    const [climb] = await db
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        name: dbSchema.boardClimbs.name,
        description: dbSchema.boardClimbs.description,
        layoutId: dbSchema.boardClimbs.layoutId,
        angle: dbSchema.boardClimbs.angle,
        frames: dbSchema.boardClimbs.frames,
        createdAt: dbSchema.boardClimbs.createdAt,
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

    if (climb) {
      const channelKey = `${boardType}:${climb.layoutId}`;
      pubsub.publishNewClimbEvent(channelKey, {
        climb: {
          uuid: climb.uuid,
          name: climb.name ?? climbName,
          boardType,
          layoutId: climb.layoutId,
          setterDisplayName: climb.setterDisplayName ?? event.metadata.setterDisplayName ?? null,
          setterAvatarUrl: climb.setterAvatarUrl ?? event.metadata.setterAvatarUrl ?? null,
          angle: climb.angle ?? null,
          frames: climb.frames ?? null,
          difficultyName: climb.difficultyName ?? event.metadata.difficultyName ?? null,
          isNoMatch: isNoMatchClimb(climb.description),
          createdAt: climb.createdAt ?? new Date().toISOString(),
        },
      });
    }
  }

  private async isDuplicate(
    actorId: string,
    recipientId: string,
    type: NotificationType,
    entityId: string,
    intervalMinutes: number,
  ): Promise<boolean> {
    const rows = await executeRows<unknown>(
      db,
      sql`
      SELECT 1 FROM notifications
      WHERE actor_id = ${actorId}
        AND recipient_id = ${recipientId}
        AND type = ${type}
        AND entity_id = ${entityId}
        AND created_at > NOW() - make_interval(mins => ${intervalMinutes})
      LIMIT 1
    `,
    );
    return rows.length > 0;
  }

  private async createAndPublishNotification(
    recipientId: string,
    actorId: string,
    type: NotificationType,
    entityType: string | null,
    entityId: string,
    commentUuid?: string,
  ): Promise<void> {
    // Guard: don't notify yourself
    if (recipientId === actorId) return;

    const uuid = crypto.randomUUID();

    // Resolve commentId from uuid if provided
    let commentId: number | undefined;
    if (commentUuid) {
      const [comment] = await db
        .select({ id: dbSchema.comments.id })
        .from(dbSchema.comments)
        .where(eq(dbSchema.comments.uuid, commentUuid))
        .limit(1);
      commentId = comment?.id;
    }

    // Persist notification
    await db.insert(dbSchema.notifications).values({
      uuid,
      recipientId,
      actorId,
      type,
      entityType: entityType as dbSchema.SocialEntityType | null,
      entityId,
      commentId,
    });

    // Enrich for real-time delivery
    const enriched = await this.enrichNotification(uuid, actorId, type, entityType, entityId, commentUuid);

    // Push to connected WS clients via PubSub
    pubsub.publishNotificationEvent(recipientId, { notification: enriched });
  }

  private async enrichNotification(
    uuid: string,
    actorId: string,
    type: NotificationType,
    entityType: string | null,
    entityId: string,
    commentUuid?: string,
  ) {
    // Fetch actor profile
    const [actor] = await db
      .select({
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(eq(dbSchema.users.id, actorId))
      .limit(1);

    // Fetch comment body preview if applicable
    let commentBody: string | undefined;
    if (commentUuid) {
      const [comment] = await db
        .select({ body: dbSchema.comments.body })
        .from(dbSchema.comments)
        .where(eq(dbSchema.comments.uuid, commentUuid))
        .limit(1);
      if (comment?.body) {
        commentBody = comment.body.length > 100 ? comment.body.slice(0, 100) + '...' : comment.body;
      }
    }

    let climbName: string | undefined;
    let climbUuid: string | undefined;
    let climbBoardType: string | undefined;
    let proposalUuid: string | undefined;

    if (type === 'new_climb' || type === 'new_climb_global') {
      const [climb] = await db
        .select({
          name: dbSchema.boardClimbs.name,
          boardType: dbSchema.boardClimbs.boardType,
        })
        .from(dbSchema.boardClimbs)
        .where(eq(dbSchema.boardClimbs.uuid, entityId))
        .limit(1);
      if (climb) {
        climbName = climb.name ?? undefined;
        climbUuid = entityId;
        climbBoardType = climb.boardType;
      }
    } else if (
      type === 'proposal_created' ||
      type === 'proposal_approved' ||
      type === 'proposal_rejected' ||
      type === 'proposal_vote'
    ) {
      // entityId is the proposal UUID — look up the associated climb
      const [proposal] = await db
        .select({
          climbUuid: dbSchema.climbProposals.climbUuid,
          boardType: dbSchema.climbProposals.boardType,
        })
        .from(dbSchema.climbProposals)
        .where(eq(dbSchema.climbProposals.uuid, entityId))
        .limit(1);
      if (proposal) {
        proposalUuid = entityId;
        climbUuid = proposal.climbUuid;
        climbBoardType = proposal.boardType;
        // Fetch climb name
        const [climb] = await db
          .select({ name: dbSchema.boardClimbs.name })
          .from(dbSchema.boardClimbs)
          .where(eq(dbSchema.boardClimbs.uuid, proposal.climbUuid))
          .limit(1);
        climbName = climb?.name ?? undefined;
      }
    }

    return {
      uuid,
      type,
      actorId,
      actorDisplayName: actor?.displayName || actor?.name || undefined,
      actorAvatarUrl: actor?.avatarUrl || actor?.image || undefined,
      entityType: entityType as dbSchema.SocialEntityType | null,
      entityId,
      commentBody,
      climbName,
      climbUuid,
      boardType: climbBoardType,
      proposalUuid,
      isRead: false,
      createdAt: new Date().toISOString(),
    };
  }
}
