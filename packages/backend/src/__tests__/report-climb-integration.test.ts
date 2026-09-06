import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { sql, eq, and } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';

/**
 * Real-DB coverage for `reportClimb` (issue #5049) and the hide proposal type.
 *
 * A report is a proposal plus a comment carrying the reporter's reason, so the
 * things worth pinning down are the ones that only show up against a real
 * database: that a second reporter joins the first one's proposal instead of
 * opening a rival, that reporting twice writes nothing, that the weighted votes
 * tip into an approval which actually flips `board_climbs.is_hidden`, and that
 * deleting the approved proposal puts the climb back.
 *
 * Seeds via raw SQL and calls the resolvers directly, mirroring
 * setter-follows-integration.test.ts and gym-write-access-and-claims.test.ts.
 */

const { mockPublishSocialEvent, mockNotifyClimbRevalidated, mockPublishCommentEvent } = vi.hoisted(() => ({
  mockPublishSocialEvent: vi.fn().mockResolvedValue(undefined),
  mockNotifyClimbRevalidated: vi.fn().mockResolvedValue(undefined),
  mockPublishCommentEvent: vi.fn(),
}));

vi.mock('../events', () => ({
  publishSocialEvent: mockPublishSocialEvent,
}));

vi.mock('../lib/web-revalidate', () => ({
  notifyClimbRevalidated: mockNotifyClimbRevalidated,
}));

vi.mock('../pubsub/index', () => ({
  pubsub: { publishCommentEvent: mockPublishCommentEvent },
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn(),
}));

import { socialProposalMutations } from '../graphql/resolvers/social/proposals/mutations';

const BOARD_TYPE = 'kilter';
const ANGLE = 40;
const CLIMB_UUID = 'report-climb-integration-climb';

const REPORTER_A = 'rc-reporter-a';
const REPORTER_B = 'rc-reporter-b';
const REPORTER_C = 'rc-reporter-c';
const ADMIN = 'rc-admin';
const ALL_USERS = [REPORTER_A, REPORTER_B, REPORTER_C, ADMIN];

const HIDE_REASON = 'These holds fell off the wall last week and it cannot be climbed.';
const GRADE_REASON = 'Everyone at the gym agrees this is at least two grades harder.';

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

async function insertUser(id: string) {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertClimb() {
  await db.execute(sql`
    INSERT INTO "board_climbs" (
      uuid, board_type, layout_id, setter_username, name, frames, frames_count,
      is_draft, is_listed, is_hidden, edge_left, edge_right, edge_bottom, edge_top, created_at
    )
    VALUES (
      ${CLIMB_UUID}, ${BOARD_TYPE}, 1, 'rc-setter', 'Reported Climb', 'p1r1', 1,
      false, true, false, 0, 100, 0, 150, '2026-01-01'
    )
  `);
}

const grantAdmin = (userId: string) =>
  db.execute(sql`
    INSERT INTO "community_roles" (user_id, role, board_type, created_at)
    VALUES (${userId}, 'admin', NULL, now())
  `);

const freezeClimbSetting = () =>
  db.execute(sql`
    INSERT INTO "community_settings" (scope, scope_key, key, value, created_at, updated_at)
    VALUES ('climb', ${CLIMB_UUID}, 'climb_frozen', 'true', now(), now())
  `);

const setClimbHidden = (hidden: boolean) =>
  db.execute(sql`
    UPDATE "board_climbs"
    SET "is_hidden" = ${hidden}, "hidden_at" = ${hidden ? sql`now()` : sql`NULL`}
    WHERE "uuid" = ${CLIMB_UUID}
  `);

const readClimbHiddenState = async () => {
  const [climb] = await db
    .select({ isHidden: dbSchema.boardClimbs.isHidden, hiddenAt: dbSchema.boardClimbs.hiddenAt })
    .from(dbSchema.boardClimbs)
    .where(eq(dbSchema.boardClimbs.uuid, CLIMB_UUID))
    .limit(1);
  return climb;
};

const readProposals = () =>
  db
    .select()
    .from(dbSchema.climbProposals)
    .where(eq(dbSchema.climbProposals.climbUuid, CLIMB_UUID))
    .orderBy(dbSchema.climbProposals.id);

/**
 * Pin an approved proposal's `resolved_at` to a fixed instant.
 *
 * `resolveProposal` stamps `resolved_at` from JS, at millisecond precision, so a
 * chain of resolutions inside one test can land on the same millisecond and
 * leave "the latest OTHER approved hide decision" for Postgres to break
 * arbitrarily. Pinning the earlier links keeps the order the revert reads.
 */
const pinResolvedAt = (proposalUuid: string, resolvedAt: Date) =>
  db.update(dbSchema.climbProposals).set({ resolvedAt }).where(eq(dbSchema.climbProposals.uuid, proposalUuid));

const readVotes = (proposalId: number) =>
  db.select().from(dbSchema.proposalVotes).where(eq(dbSchema.proposalVotes.proposalId, proposalId));

const readComments = (proposalUuid: string) =>
  db
    .select()
    .from(dbSchema.comments)
    .where(and(eq(dbSchema.comments.entityType, 'proposal'), eq(dbSchema.comments.entityId, proposalUuid)))
    .orderBy(dbSchema.comments.id);

const reportHide = (userId: string, overrides: Record<string, unknown> = {}) =>
  socialProposalMutations.reportClimb(
    null,
    { input: { climbUuid: CLIMB_UUID, boardType: BOARD_TYPE, kind: 'hide', reason: HIDE_REASON, ...overrides } },
    authCtx(userId),
  );

const reportGrade = (userId: string, proposedGrade: string, overrides: Record<string, unknown> = {}) =>
  socialProposalMutations.reportClimb(
    null,
    {
      input: {
        climbUuid: CLIMB_UUID,
        boardType: BOARD_TYPE,
        angle: ANGLE,
        kind: 'grade',
        proposedGrade,
        reason: GRADE_REASON,
        ...overrides,
      },
    },
    authCtx(userId),
  );

const voteOnProposal = (userId: string, proposalUuid: string, value: number) =>
  socialProposalMutations.voteOnProposal(null, { input: { proposalUuid, value } }, authCtx(userId));

const createHideProposal = (userId: string, overrides: Record<string, unknown> = {}) =>
  socialProposalMutations.createProposal(
    null,
    {
      input: {
        climbUuid: CLIMB_UUID,
        boardType: BOARD_TYPE,
        type: 'hide',
        proposedValue: 'true',
        reason: HIDE_REASON,
        ...overrides,
      },
    },
    authCtx(userId),
  );

describe('reportClimb', () => {
  beforeEach(async () => {
    mockPublishSocialEvent.mockClear();
    mockNotifyClimbRevalidated.mockClear();
    mockPublishCommentEvent.mockClear();

    await db.execute(sql`DELETE FROM "comments" WHERE entity_type = 'proposal'`);
    await db.execute(sql`DELETE FROM "proposal_votes"`);
    await db.execute(sql`DELETE FROM "climb_community_status"`);
    await db.execute(sql`DELETE FROM "climb_classic_status"`);
    await db.execute(sql`DELETE FROM "climb_proposals"`);
    await db.execute(sql`DELETE FROM "community_settings"`);
    await db.execute(sql`DELETE FROM "community_roles"`);
    await db.execute(sql`DELETE FROM "board_climb_stats"`);
    await db.execute(sql`DELETE FROM "board_climbs" WHERE "uuid" = ${CLIMB_UUID}`);

    for (const userId of ALL_USERS) {
      await insertUser(userId);
    }
    await insertClimb();
  });

  it('opens a hide proposal with the reporter vote and their reason as a comment', async () => {
    const result = await reportHide(REPORTER_A);

    expect(result.status).toBe('created');

    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe('hide');
    expect(proposals[0].angle).toBeNull();
    expect(proposals[0].proposedValue).toBe('true');
    expect(proposals[0].currentValue).toBe('false');
    expect(proposals[0].status).toBe('open');
    expect(proposals[0].reason).toBe(HIDE_REASON);

    const votes = await readVotes(proposals[0].id);
    expect(votes).toHaveLength(1);
    expect(votes[0].userId).toBe(REPORTER_A);
    expect(votes[0].value).toBe(1);
    expect(votes[0].weight).toBe(1);

    const comments = await readComments(proposals[0].uuid);
    expect(comments).toHaveLength(1);
    expect(comments[0].userId).toBe(REPORTER_A);
    expect(comments[0].body).toBe(HIDE_REASON);

    // The live thread hears about it; the activity feed deliberately does not.
    expect(mockPublishCommentEvent).toHaveBeenCalledTimes(1);
    const publishedEventTypes = mockPublishSocialEvent.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(publishedEventTypes).toContain('proposal.created');
    expect(publishedEventTypes).not.toContain('comment.created');
  });

  it('joins the second reporter onto the open proposal instead of opening a rival', async () => {
    await reportHide(REPORTER_A);
    const result = await reportHide(REPORTER_B);

    expect(result.status).toBe('added');
    expect(result.proposal.upvoterCount).toBe(2);
    expect(result.proposal.commentCount).toBe(2);
    expect(result.proposal.weightedUpvotes).toBe(2);

    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);

    const votes = await readVotes(proposals[0].id);
    expect(votes.map((vote) => vote.userId).sort()).toEqual([REPORTER_A, REPORTER_B]);

    const comments = await readComments(proposals[0].uuid);
    expect(comments).toHaveLength(2);
  });

  it('treats a repeat report from the same user as a no-op', async () => {
    await reportHide(REPORTER_A);
    await reportHide(REPORTER_B);

    const result = await reportHide(REPORTER_B);

    expect(result.status).toBe('already_reported');
    expect(result.proposal.upvoterCount).toBe(2);
    expect(result.proposal.commentCount).toBe(2);

    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);
    expect(await readVotes(proposals[0].id)).toHaveLength(2);
    expect(await readComments(proposals[0].uuid)).toHaveLength(2);
  });

  it('adds no second comment when a reporter toggles off and reports again', async () => {
    // report → toggle the vote off → report again must restore the vote but
    // not append another reason each lap (that would be a comment-spam vector).
    await reportHide(REPORTER_A);
    const [openProposal] = await readProposals();

    // Same value again on the existing +1 is the toggle-off.
    await voteOnProposal(REPORTER_A, openProposal.uuid, 1);
    expect(await readVotes(openProposal.id)).toHaveLength(0);

    const again = await reportHide(REPORTER_A, { reason: 'A different reason the second time around' });
    expect(again.status).toBe('added');
    expect(await readVotes(openProposal.id)).toHaveLength(1);

    const comments = await readComments(openProposal.uuid);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe(HIDE_REASON);
  });

  it('flips a prior downvote into the report instead of swallowing it', async () => {
    // Someone who voted the hide DOWN and later hits report has changed their
    // mind. Treating that as "already reported" would keep their -1 holding the
    // tally down while the UI told them their report had landed.
    await reportHide(REPORTER_A);
    const [openProposal] = await readProposals();

    await voteOnProposal(REPORTER_B, openProposal.uuid, -1);

    const result = await reportHide(REPORTER_B);

    expect(result.status).toBe('added');
    expect(result.proposal.weightedUpvotes).toBe(2);
    expect(result.proposal.upvoterCount).toBe(2);
    expect(result.proposal.weightedDownvotes).toBe(0);

    const votes = await readVotes(openProposal.id);
    expect(votes).toHaveLength(2);
    const flipped = votes.find((vote) => vote.userId === REPORTER_B);
    expect(flipped?.value).toBe(1);
    expect(flipped?.weight).toBe(1);

    // One comment per report, not per vote: A's reason plus B's.
    const comments = await readComments(openProposal.uuid);
    expect(comments).toHaveLength(2);
    expect(comments[1].userId).toBe(REPORTER_B);
    expect(comments[1].body).toBe(HIDE_REASON);

    const votedEvents = mockPublishSocialEvent.mock.calls
      .map((call) => call[0] as { type: string; metadata?: Record<string, unknown> })
      .filter((event) => event.type === 'proposal.voted');
    expect(votedEvents.at(-1)?.metadata?.value).toBe('1');
  });

  it('hides the climb once weighted upvotes reach the threshold', async () => {
    await grantAdmin(ADMIN);

    await reportHide(REPORTER_A);
    await reportHide(REPORTER_B);
    expect((await readClimbHiddenState()).isHidden).toBe(false);

    // The admin's vote weighs 3, taking the tally from 2 to the required 5.
    const result = await reportHide(ADMIN);
    expect(result.status).toBe('added');
    expect(result.proposal.status).toBe('approved');
    expect(result.proposal.weightedUpvotes).toBe(5);
    expect(result.proposal.upvoterCount).toBe(3);

    // The status flip and the effect ride one transaction, so the two rows can
    // only ever agree: an approved proposal over a visible climb would mean the
    // effect was lost, and a hidden climb with an open proposal would mean it
    // ran early.
    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('approved');
    expect(proposals[0].resolvedAt).toBeInstanceOf(Date);

    const climb = await readClimbHiddenState();
    expect(climb.isHidden).toBe(true);
    expect(climb.hiddenAt).toBeInstanceOf(Date);
  });

  it('carries a stalled at-threshold proposal over on a duplicate report', async () => {
    // The retry case: a reporter's vote committed but the approval that should
    // have followed it did not — a dropped connection, a restarted process. The
    // client retries and gets `already_reported`; if auto-approval were skipped
    // on that path the proposal would sit at threshold forever with nobody left
    // to carry it. "Open AND already at threshold" can only be reached by
    // writing the extra weight straight to `proposal_votes`, because every
    // resolver door runs the approval on its way out.
    await reportHide(REPORTER_A);
    const [stalled] = await readProposals();
    expect(stalled.status).toBe('open');

    // REPORTER_A's own +1 weighs 1; this takes the tally to the required 5.
    await db.insert(dbSchema.proposalVotes).values({
      proposalId: stalled.id,
      userId: REPORTER_B,
      value: 1,
      weight: 4,
    });
    expect((await readClimbHiddenState()).isHidden).toBe(false);

    const retry = await reportHide(REPORTER_A);

    // The duplicate still writes nothing: no second vote, no second reason.
    expect(retry.status).toBe('already_reported');
    expect(await readVotes(stalled.id)).toHaveLength(2);
    expect(await readComments(stalled.uuid)).toHaveLength(1);

    // ...and the approval the proposal was owed finally ran.
    expect(retry.proposal.status).toBe('approved');
    const [resolved] = await readProposals();
    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    const climb = await readClimbHiddenState();
    expect(climb.isHidden).toBe(true);
    expect(climb.hiddenAt).toBeInstanceOf(Date);
  });

  it('unhides the climb when an admin deletes the approved hide proposal', async () => {
    await grantAdmin(ADMIN);
    await reportHide(REPORTER_A);
    await reportHide(REPORTER_B);
    await reportHide(ADMIN);
    expect((await readClimbHiddenState()).isHidden).toBe(true);

    const [approved] = await readProposals();
    const deleted = await socialProposalMutations.deleteProposal(
      null,
      { input: { proposalUuid: approved.uuid } },
      authCtx(ADMIN),
    );

    expect(deleted).toBe(true);
    const climb = await readClimbHiddenState();
    expect(climb.isHidden).toBe(false);
    expect(climb.hiddenAt).toBeNull();
  });

  it('reverting the newest hide restores the unhide that preceded it (three-step chain)', async () => {
    // Three approved hide decisions stacked up: hidden, visible again, hidden
    // again. Deleting the newest one has to fall back to the decision directly
    // behind it — the unhide — and deleting that one in turn has to fall back
    // to the original hide. Only the second half separates "reads the chain"
    // from "reverts a hide by making the climb visible", which would pass the
    // first half on its own.
    await grantAdmin(ADMIN);

    // Admin weight is 3 against a threshold of 5, so nothing auto-approves:
    // every step below is a moderator decision through resolveProposal.
    const firstHide = await createHideProposal(ADMIN);
    expect(firstHide.status).toBe('open');
    await socialProposalMutations.resolveProposal(
      null,
      { input: { proposalUuid: firstHide.uuid, status: 'approved' } },
      authCtx(ADMIN),
    );
    expect((await readClimbHiddenState()).isHidden).toBe(true);
    await pinResolvedAt(firstHide.uuid, new Date('2026-01-01T00:00:00.000Z'));

    const unhide = await createHideProposal(ADMIN, {
      proposedValue: 'false',
      reason: 'The holds were replaced, this one climbs fine again.',
    });
    await socialProposalMutations.resolveProposal(
      null,
      { input: { proposalUuid: unhide.uuid, status: 'approved' } },
      authCtx(ADMIN),
    );
    const afterUnhide = await readClimbHiddenState();
    expect(afterUnhide.isHidden).toBe(false);
    expect(afterUnhide.hiddenAt).toBeNull();
    await pinResolvedAt(unhide.uuid, new Date('2026-02-01T00:00:00.000Z'));

    const secondHide = await createHideProposal(ADMIN);
    await socialProposalMutations.resolveProposal(
      null,
      { input: { proposalUuid: secondHide.uuid, status: 'approved' } },
      authCtx(ADMIN),
    );
    expect((await readClimbHiddenState()).isHidden).toBe(true);

    const deletedNewest = await socialProposalMutations.deleteProposal(
      null,
      { input: { proposalUuid: secondHide.uuid } },
      authCtx(ADMIN),
    );

    expect(deletedNewest).toBe(true);
    const revertedClimb = await readClimbHiddenState();
    expect(revertedClimb.isHidden).toBe(false);
    expect(revertedClimb.hiddenAt).toBeNull();

    // Only the deleted row is gone; the two decisions behind it still stand.
    const remaining = await readProposals();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((proposal) => proposal.uuid)).toEqual([firstHide.uuid, unhide.uuid]);
    expect(remaining.map((proposal) => proposal.status)).toEqual(['approved', 'approved']);
    expect(remaining.map((proposal) => proposal.proposedValue)).toEqual(['true', 'false']);

    // One link further back: with the unhide gone too, the original hide is the
    // latest decision left, so the climb goes back to hidden and carries that
    // proposal's own resolution time rather than a fresh timestamp.
    expect(
      await socialProposalMutations.deleteProposal(null, { input: { proposalUuid: unhide.uuid } }, authCtx(ADMIN)),
    ).toBe(true);

    const [survivingHide] = await readProposals();
    expect(survivingHide.uuid).toBe(firstHide.uuid);
    const rehiddenClimb = await readClimbHiddenState();
    expect(rehiddenClimb.isHidden).toBe(true);
    expect(rehiddenClimb.hiddenAt).toEqual(survivingHide.resolvedAt);
  });

  it('joins a grade report asking for the same grade', async () => {
    const first = await reportGrade(REPORTER_A, '6c/V5');
    expect(first.status).toBe('created');

    const second = await reportGrade(REPORTER_B, '6c/V5');
    expect(second.status).toBe('added');
    expect(second.proposal.upvoterCount).toBe(2);

    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe('grade');
    expect(proposals[0].angle).toBe(ANGLE);
    expect(proposals[0].proposedValue).toBe('6c/V5');
  });

  it('supersedes the open grade proposal when a reporter asks for a different grade', async () => {
    await reportGrade(REPORTER_A, '6c/V5');
    const second = await reportGrade(REPORTER_B, '7a/V6');

    expect(second.status).toBe('created');

    const proposals = await readProposals();
    expect(proposals).toHaveLength(2);
    expect(proposals[0].proposedValue).toBe('6c/V5');
    expect(proposals[0].status).toBe('superseded');
    expect(proposals[1].proposedValue).toBe('7a/V6');
    expect(proposals[1].status).toBe('open');
  });

  it('rejects a grade report with no angle', async () => {
    await expect(reportGrade(REPORTER_A, '6c/V5', { angle: null })).rejects.toThrow(
      /Angle is required for grade reports/,
    );
    expect(await readProposals()).toHaveLength(0);
  });

  it('stores a null angle when a hide report carries the viewer angle', async () => {
    await reportHide(REPORTER_A, { angle: ANGLE });

    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].angle).toBeNull();
  });

  it('rejects a reason shorter than ten characters', async () => {
    await expect(reportHide(REPORTER_A, { reason: 'too short' })).rejects.toThrow(/at least 10 characters/);
    expect(await readProposals()).toHaveLength(0);
  });

  it('rejects a report on a frozen climb', async () => {
    await freezeClimbSetting();

    await expect(reportHide(REPORTER_A)).rejects.toThrow(/frozen/);
    expect(await readProposals()).toHaveLength(0);
  });

  it('rejects a hide report on a climb that is already hidden', async () => {
    await setClimbHidden(true);

    await expect(reportHide(REPORTER_A)).rejects.toThrow(/already hidden/);
    expect(await readProposals()).toHaveLength(0);
  });

  it('opens one proposal when two people report the same climb at the same instant', async () => {
    // Both requests read "no open proposal" within a millisecond of each other
    // unless the advisory lock serialises them; two open rows would split the
    // votes and neither would ever reach the threshold.
    const outcomes = await Promise.all([reportHide(REPORTER_A), reportHide(REPORTER_B)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['added', 'created']);

    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('open');
    expect(await readVotes(proposals[0].id)).toHaveLength(2);
    expect(await readComments(proposals[0].uuid)).toHaveLength(2);
  });

  it('opens one proposal when two grade reports for the same grade race', async () => {
    const outcomes = await Promise.all([reportGrade(REPORTER_A, '6c/V5'), reportGrade(REPORTER_B, '6c/V5')]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['added', 'created']);

    const proposals = await readProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe('grade');
    expect(proposals[0].proposedValue).toBe('6c/V5');
    expect(await readVotes(proposals[0].id)).toHaveLength(2);
    expect(await readComments(proposals[0].uuid)).toHaveLength(2);
  });

  it('rejects a hide proposal whose reason is too short', async () => {
    // createProposal is the other door to the same outcome — a climb pulled from
    // everyone's browse — so it carries the report's reason floor too.
    await expect(createHideProposal(REPORTER_A, { reason: 'broke' })).rejects.toThrow(/at least 10 characters/);
    expect(await readProposals()).toHaveLength(0);
    expect(mockPublishCommentEvent).not.toHaveBeenCalled();
  });

  it('records the reason as a comment when a hide proposal is created directly', async () => {
    const proposal = await createHideProposal(REPORTER_A);

    const comments = await readComments(proposal.uuid);
    expect(comments).toHaveLength(1);
    expect(comments[0].userId).toBe(REPORTER_A);
    expect(comments[0].body).toBe(HIDE_REASON);

    // Same split reportClimb makes: the live thread hears it, the feed doesn't.
    expect(mockPublishCommentEvent).toHaveBeenCalledTimes(1);
    const publishedEventTypes = mockPublishSocialEvent.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(publishedEventTypes).toContain('proposal.created');
    expect(publishedEventTypes).not.toContain('comment.created');
  });

  it('leaves a grade proposal created directly without a comment', async () => {
    const proposal = await socialProposalMutations.createProposal(
      null,
      {
        input: {
          climbUuid: CLIMB_UUID,
          boardType: BOARD_TYPE,
          angle: ANGLE,
          type: 'grade',
          proposedValue: '6c/V5',
          reason: 'Feels a lot harder than the board says.',
        },
      },
      authCtx(REPORTER_A),
    );

    expect(await readComments(proposal.uuid)).toHaveLength(0);
    expect(mockPublishCommentEvent).not.toHaveBeenCalled();
  });

  it('serialises two concurrent votes from the same user', async () => {
    await reportHide(REPORTER_A);
    const [proposal] = await readProposals();

    // Unserialised, both calls read "no vote yet" and both insert — the unique
    // index on (proposal_id, user_id) then hands the loser an error the voter
    // sees. Under the lock the second call reads the first one's committed +1
    // and is the toggle-off a second tap has always meant: never two rows for
    // one voter, and nothing thrown either way.
    await Promise.all([voteOnProposal(REPORTER_B, proposal.uuid, 1), voteOnProposal(REPORTER_B, proposal.uuid, 1)]);

    const votes = await readVotes(proposal.id);
    expect(votes.filter((vote) => vote.userId === REPORTER_B).length).toBeLessThanOrEqual(1);
    expect(votes.filter((vote) => vote.userId === REPORTER_A)).toHaveLength(1);
  });

  it('keeps concurrent votes from different users as separate rows', async () => {
    await reportHide(REPORTER_A);
    const [proposal] = await readProposals();

    await Promise.all([voteOnProposal(REPORTER_B, proposal.uuid, 1), voteOnProposal(REPORTER_C, proposal.uuid, 1)]);

    const votes = await readVotes(proposal.id);
    expect(votes.map((vote) => vote.userId).sort()).toEqual([REPORTER_A, REPORTER_B, REPORTER_C].sort());
    expect(votes.every((vote) => vote.value === 1)).toBe(true);
  });

  it('unhides a climb through an admin-resolved unhide proposal', async () => {
    await grantAdmin(ADMIN);
    await setClimbHidden(true);

    const proposal = await socialProposalMutations.createProposal(
      null,
      {
        input: {
          climbUuid: CLIMB_UUID,
          boardType: BOARD_TYPE,
          type: 'hide',
          proposedValue: 'false',
          reason: 'The holds were replaced, this one climbs fine again.',
        },
      },
      authCtx(REPORTER_A),
    );

    expect(proposal.status).toBe('open');
    expect(proposal.currentValue).toBe('true');
    expect(proposal.climbIsHidden).toBe(true);
    expect((await readClimbHiddenState()).isHidden).toBe(true);

    const resolved = await socialProposalMutations.resolveProposal(
      null,
      { input: { proposalUuid: proposal.uuid, status: 'approved' } },
      authCtx(ADMIN),
    );

    expect(resolved.status).toBe('approved');
    const climb = await readClimbHiddenState();
    expect(climb.isHidden).toBe(false);
    expect(climb.hiddenAt).toBeNull();
  });
});
