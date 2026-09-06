import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import type { SocialEvent } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';

import { db } from '../db/client';
import type { EventBroker } from '../events/event-broker';
import { fanoutProposalApprovedFeedItems } from '../events/feed-fanout';
import { isHideProposalEvent, NotificationWorker } from '../events/notification-worker';
import { resolveClimbSetterRecipients } from '../events/recipient-resolution';

// The feed fan-out is the ONE thing here that must not happen for a hide, so it
// is the one module that gets stubbed — everything else (recipients,
// notification rows) runs against the real database.
vi.mock('../events/feed-fanout', () => ({
  fanoutFeedItems: vi.fn(async () => {}),
  fanoutNewClimbFeedItems: vi.fn(async () => {}),
  fanoutCommentFeedItems: vi.fn(async () => {}),
  fanoutProposalApprovedFeedItems: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// The setter is a first-class recipient of a report (#5049).
//
// `proposal.created` used to notify only the people who had ticked the climb.
// A report ("hide this climb", "this grade is wrong") is news for the person
// who set it, and they may never have ticked their own climb — so they now get
// their own notification type, `proposal_on_your_climb`.
//
// A climb points at a Boardsesh account two ways, and both have to work:
//   * authored on Boardsesh  -> `board_climbs.user_id`
//   * synced from Aurora     -> `board_climbs.setter_id` matched against
//                               `aurora_credentials.aurora_user_id`
//
// Real DB: the Aurora path is a two-table join that a mock would only
// re-express, and the "exactly one notification" claim is about rows.
// ---------------------------------------------------------------------------

const PREFIX = 'proposal-setter-recipient';

let fixtureCounter = 0;

function nextId(): string {
  return `${PREFIX}-${++fixtureCounter}`;
}

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${`${id}@test.com`}, ${id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertClimb(params: {
  uuid: string;
  boardType: string;
  userId?: string | null;
  setterId?: number | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO "board_climbs" (
      uuid, board_type, layout_id, setter_id, setter_username, name, frames,
      frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom,
      edge_top, created_at, user_id
    )
    VALUES (
      ${params.uuid}, ${params.boardType}, 1, ${params.setterId ?? null}, 'setter',
      ${params.uuid}, 'p1r1', 1, false, true, 0, 100, 0, 150, '2026-01-01',
      ${params.userId ?? null}
    )
  `);
}

async function linkAuroraAccount(userId: string, boardType: string, auroraUserId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO "aurora_credentials" (user_id, board_type, aurora_user_id, sync_status, created_at, updated_at)
    VALUES (${userId}, ${boardType}, ${auroraUserId}, 'active', now(), now())
  `);
}

async function insertTick(userId: string, climbUuid: string, boardType: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "boardsesh_ticks" (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
    VALUES (${`${climbUuid}-tick-${userId}`}, ${userId}, ${boardType}, ${climbUuid}, 40, 'send', now())
  `);
}

async function insertProposal(params: {
  uuid: string;
  climbUuid: string;
  boardType: string;
  proposerId: string;
  type: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO "climb_proposals" (uuid, climb_uuid, board_type, angle, proposer_id, type, proposed_value, current_value, status, created_at)
    VALUES (${params.uuid}, ${params.climbUuid}, ${params.boardType}, NULL, ${params.proposerId}, ${params.type}, 'true', 'false', 'open', now())
  `);
}

async function notificationTypesFor(recipientId: string): Promise<string[]> {
  const rows = await db
    .select({ type: dbSchema.notifications.type })
    .from(dbSchema.notifications)
    .where(eq(dbSchema.notifications.recipientId, recipientId));
  return rows.map((row) => row.type);
}

/**
 * Reach the worker's private `proposal.created` handler the way production
 * does: `start()` hands `processEvent` to the broker, so a stub broker that
 * keeps the callback lets a test drive the real routing without Redis.
 */
function captureWorkerHandler(): (event: SocialEvent) => Promise<void> {
  let handler: ((event: SocialEvent) => Promise<void>) | undefined;
  const stubBroker = {
    startConsumer: (consume: (event: SocialEvent) => Promise<void>) => {
      handler = consume;
    },
  } as unknown as EventBroker;

  new NotificationWorker(stubBroker).start();

  if (!handler) throw new Error('NotificationWorker did not register a consumer');
  return handler;
}

function proposalCreatedEvent(params: {
  actorId: string;
  proposalUuid: string;
  climbUuid: string;
  boardType: string;
}): SocialEvent {
  return {
    type: 'proposal.created',
    actorId: params.actorId,
    entityType: 'proposal',
    entityId: params.proposalUuid,
    timestamp: Date.now(),
    metadata: {
      climbUuid: params.climbUuid,
      boardType: params.boardType,
      proposalType: 'hide',
    },
  };
}

function proposalApprovedEvent(params: {
  actorId: string;
  proposalUuid: string;
  climbUuid: string;
  boardType: string;
  proposalType: string;
}): SocialEvent {
  return {
    type: 'proposal.approved',
    actorId: params.actorId,
    entityType: 'proposal',
    entityId: params.proposalUuid,
    timestamp: Date.now(),
    metadata: {
      climbUuid: params.climbUuid,
      boardType: params.boardType,
      proposalType: params.proposalType,
    },
  };
}

describe('climb setter recipients (real DB)', () => {
  afterEach(async () => {
    await db.execute(sql`DELETE FROM "notifications" WHERE "recipient_id" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "climb_proposals" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "boardsesh_ticks" WHERE "user_id" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "aurora_credentials" WHERE "user_id" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "board_climbs" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "users" WHERE "id" LIKE ${`${PREFIX}-%`}`);
  });

  it('resolves the author of a Boardsesh-created climb', async () => {
    const setterId = nextId();
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    await insertUser(setterId);
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: setterId });

    const recipients = await resolveClimbSetterRecipients(climbUuid, 'kilter', reporterId);

    expect(recipients).toEqual([{ recipientId: setterId, notificationType: 'proposal_on_your_climb' }]);
  });

  it('resolves the linked Aurora account of a synced climb', async () => {
    const setterId = nextId();
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    await insertUser(setterId);
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: null, setterId: 424242 });
    await linkAuroraAccount(setterId, 'kilter', 424242);

    const recipients = await resolveClimbSetterRecipients(climbUuid, 'kilter', reporterId);

    expect(recipients).toEqual([{ recipientId: setterId, notificationType: 'proposal_on_your_climb' }]);
  });

  it('resolves the author AND the linked Aurora account when a climb carries both', async () => {
    // `setter-overrides.ts` grants setter powers on either match, so a climb
    // with a user_id and a setter_id has two people who can act as its setter.
    // Resolving only the first left the other holding the powers while never
    // hearing that their climb had been reported.
    const authorId = nextId();
    const auroraSetterId = nextId();
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    await insertUser(authorId);
    await insertUser(auroraSetterId);
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: authorId, setterId: 636363 });
    await linkAuroraAccount(auroraSetterId, 'kilter', 636363);

    const recipients = await resolveClimbSetterRecipients(climbUuid, 'kilter', reporterId);

    expect(recipients).toHaveLength(2);
    expect(recipients).toEqual(
      expect.arrayContaining([
        { recipientId: authorId, notificationType: 'proposal_on_your_climb' },
        { recipientId: auroraSetterId, notificationType: 'proposal_on_your_climb' },
      ]),
    );
  });

  it('counts an author who is also the linked Aurora account once', async () => {
    const setterId = nextId();
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    await insertUser(setterId);
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: setterId, setterId: 727272 });
    await linkAuroraAccount(setterId, 'kilter', 727272);

    const recipients = await resolveClimbSetterRecipients(climbUuid, 'kilter', reporterId);

    expect(recipients).toEqual([{ recipientId: setterId, notificationType: 'proposal_on_your_climb' }]);
  });

  it('ignores an Aurora account linked for a different board type', async () => {
    const setterId = nextId();
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    await insertUser(setterId);
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: null, setterId: 424242 });
    await linkAuroraAccount(setterId, 'tension', 424242);

    expect(await resolveClimbSetterRecipients(climbUuid, 'kilter', reporterId)).toEqual([]);
  });

  it('never notifies the reporter about their own climb', async () => {
    const setterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    await insertUser(setterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: setterId });

    expect(await resolveClimbSetterRecipients(climbUuid, 'kilter', setterId)).toEqual([]);
  });

  it('returns nothing when the climb has no setter at all', async () => {
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: null, setterId: null });

    expect(await resolveClimbSetterRecipients(climbUuid, 'kilter', reporterId)).toEqual([]);
  });
});

describe('proposal.created notifications (real DB)', () => {
  afterEach(async () => {
    await db.execute(sql`DELETE FROM "notifications" WHERE "recipient_id" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "climb_proposals" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "boardsesh_ticks" WHERE "user_id" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "aurora_credentials" WHERE "user_id" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "board_climbs" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "users" WHERE "id" LIKE ${`${PREFIX}-%`}`);
  });

  it('gives a setter who also ticked the climb exactly one notification', async () => {
    const setterId = nextId();
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    const proposalUuid = `${nextId()}-proposal`;

    await insertUser(setterId);
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: setterId });
    // The setter has ticked their own climb, so they are also in the ticker set.
    await insertTick(setterId, climbUuid, 'kilter');
    await insertProposal({
      uuid: proposalUuid,
      climbUuid,
      boardType: 'kilter',
      proposerId: reporterId,
      type: 'hide',
    });

    const handleEvent = captureWorkerHandler();
    await handleEvent(proposalCreatedEvent({ actorId: reporterId, proposalUuid, climbUuid, boardType: 'kilter' }));

    expect(await notificationTypesFor(setterId)).toEqual(['proposal_on_your_climb']);
  });

  it('notifies the setter and the other climbers with their own types', async () => {
    const setterId = nextId();
    const climberId = nextId();
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    const proposalUuid = `${nextId()}-proposal`;

    await insertUser(setterId);
    await insertUser(climberId);
    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: null, setterId: 515151 });
    await linkAuroraAccount(setterId, 'kilter', 515151);
    await insertTick(climberId, climbUuid, 'kilter');
    await insertProposal({
      uuid: proposalUuid,
      climbUuid,
      boardType: 'kilter',
      proposerId: reporterId,
      type: 'grade',
    });

    const handleEvent = captureWorkerHandler();
    await handleEvent(proposalCreatedEvent({ actorId: reporterId, proposalUuid, climbUuid, boardType: 'kilter' }));

    expect(await notificationTypesFor(setterId)).toEqual(['proposal_on_your_climb']);
    expect(await notificationTypesFor(climberId)).toEqual(['proposal_created']);
    expect(await notificationTypesFor(reporterId)).toEqual([]);
  });

  it('does not notify a setter who reported their own climb', async () => {
    const setterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    const proposalUuid = `${nextId()}-proposal`;

    await insertUser(setterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: setterId });
    await insertProposal({
      uuid: proposalUuid,
      climbUuid,
      boardType: 'kilter',
      proposerId: setterId,
      type: 'hide',
    });

    const handleEvent = captureWorkerHandler();
    await handleEvent(proposalCreatedEvent({ actorId: setterId, proposalUuid, climbUuid, boardType: 'kilter' }));

    expect(await notificationTypesFor(setterId)).toEqual([]);
  });
});

describe('isHideProposalEvent (real DB)', () => {
  afterEach(async () => {
    await db.execute(sql`DELETE FROM "climb_proposals" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "board_climbs" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "users" WHERE "id" LIKE ${`${PREFIX}-%`}`);
  });

  function approvedEvent(proposalUuid: string, proposalType?: string): SocialEvent {
    return {
      type: 'proposal.approved',
      actorId: 'irrelevant',
      entityType: 'proposal',
      entityId: proposalUuid,
      timestamp: Date.now(),
      metadata: proposalType ? { proposalType } : {},
    };
  }

  it('trusts the event metadata when the publisher sets it', async () => {
    expect(await isHideProposalEvent(approvedEvent('never-read', 'hide'))).toBe(true);
    expect(await isHideProposalEvent(approvedEvent('never-read', 'grade'))).toBe(false);
  });

  it('reads the proposal row when the event carries no type', async () => {
    const proposerId = nextId();
    const climbUuid = `${nextId()}-climb`;
    const hideUuid = `${nextId()}-hide-proposal`;
    const gradeUuid = `${nextId()}-grade-proposal`;

    await insertUser(proposerId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: proposerId });
    await insertProposal({ uuid: hideUuid, climbUuid, boardType: 'kilter', proposerId, type: 'hide' });
    await insertProposal({ uuid: gradeUuid, climbUuid, boardType: 'kilter', proposerId, type: 'grade' });

    expect(await isHideProposalEvent(approvedEvent(hideUuid))).toBe(true);
    expect(await isHideProposalEvent(approvedEvent(gradeUuid))).toBe(false);
  });

  it('treats a missing proposal as not a hide', async () => {
    expect(await isHideProposalEvent(approvedEvent(`${PREFIX}-does-not-exist`))).toBe(false);
  });
});

describe('proposal.approved feed fan-out (real DB)', () => {
  beforeEach(() => {
    vi.mocked(fanoutProposalApprovedFeedItems).mockClear();
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM "notifications" WHERE "recipient_id" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "climb_proposals" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "board_climbs" WHERE "uuid" LIKE ${`${PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "users" WHERE "id" LIKE ${`${PREFIX}-%`}`);
  });

  it('writes no feed rows when a hide is approved', async () => {
    // Hiding a climb is a moderation outcome. Announcing it in the reporter's
    // followers' feeds would put the removed climb back in front of people —
    // everyone with a stake already has a notification.
    const reporterId = nextId();
    const climbUuid = `${nextId()}-climb`;
    const proposalUuid = `${nextId()}-proposal`;

    await insertUser(reporterId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: null, setterId: null });
    await insertProposal({ uuid: proposalUuid, climbUuid, boardType: 'kilter', proposerId: reporterId, type: 'hide' });

    const handleEvent = captureWorkerHandler();
    await handleEvent(
      proposalApprovedEvent({ actorId: reporterId, proposalUuid, climbUuid, boardType: 'kilter', proposalType: 'hide' }),
    );

    expect(fanoutProposalApprovedFeedItems).not.toHaveBeenCalled();
  });

  it('still writes feed rows when a grade change is approved', async () => {
    const proposerId = nextId();
    const climbUuid = `${nextId()}-climb`;
    const proposalUuid = `${nextId()}-proposal`;

    await insertUser(proposerId);
    await insertClimb({ uuid: climbUuid, boardType: 'kilter', userId: null, setterId: null });
    await insertProposal({ uuid: proposalUuid, climbUuid, boardType: 'kilter', proposerId, type: 'grade' });

    const handleEvent = captureWorkerHandler();
    await handleEvent(
      proposalApprovedEvent({
        actorId: proposerId,
        proposalUuid,
        climbUuid,
        boardType: 'kilter',
        proposalType: 'grade',
      }),
    );

    expect(fanoutProposalApprovedFeedItems).toHaveBeenCalledTimes(1);
  });
});
