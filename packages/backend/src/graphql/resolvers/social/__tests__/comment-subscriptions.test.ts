/**
 * Tests for the commentUpdates subscription resolver.
 *
 * Validation (issue #2357): the resolver guards `entityType` against an
 * allow-list before opening a pubsub channel. That list used to be hand-rolled
 * and silently dropped 'session' and 'gym', so realtime comments on
 * /session/:sessionId and gym detail pages threw `Invalid entity type: session`
 * on subscribe and never delivered events. The fix derives the allow-list from
 * the shared Zod enum `SocialEntityTypeSchema`, so these tests lock the two
 * lists together. Validation runs before any DB/Redis access, so those cases
 * stub the privacy checks.
 *
 * Deleted comments: a `CommentDeleted` event is checked against the tombstone
 * it carries plus the subscription's own item, against the real database, so
 * the item's owner and the people who replied hear about it and a stranger
 * does not when its author was private. pubsub and the async-iterator helper
 * stay mocked; the events come from the real `deleteComment` mutation.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';
import type { CommentEvent, ConnectionContext } from '@boardsesh/shared-schema';

// `real` switches the privacy checks from always-allow to the real SQL;
// `published` collects what the resolvers publish; `events` is what the next
// subscription's iterator replays before it completes.
const harness = vi.hoisted(() => ({ real: false, published: [] as CommentEvent[], events: [] as CommentEvent[] }));

vi.mock('../../../../pubsub/index', () => ({
  pubsub: {
    subscribeComments: vi.fn(),
    publishCommentEvent: (_entityKey: string, event: CommentEvent) => {
      harness.published.push(event);
    },
  },
}));

vi.mock('../../shared/activity-privacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/activity-privacy')>();
  return {
    ...actual,
    canReadSocialEntity: vi.fn((...args: Parameters<typeof actual.canReadSocialEntity>) =>
      harness.real ? actual.canReadSocialEntity(...args) : Promise.resolve(true),
    ),
    canReadDeletedComment: vi.fn((...args: Parameters<typeof actual.canReadDeletedComment>) =>
      harness.real ? actual.canReadDeletedComment(...args) : Promise.resolve(true),
    ),
  };
});

// createPrivacyAwareIterator resolves to an iterable over `harness.events` that
// then completes, so with no events a subscription whose entityType passes
// validation finishes on the first next().
vi.mock('../../shared/privacy-iterator', () => ({
  createPrivacyAwareIterator: vi.fn(async () => {
    const pending = [...harness.events];
    return {
      return: async () => ({ value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const event = pending.shift();
            return event ? { value: event, done: false } : { value: undefined, done: true };
          },
        };
      },
    };
  }),
}));

import { db } from '../../../../db/client';
import { socialCommentSubscriptions } from '../comment-subscriptions';
import { socialCommentMutations } from '../comments';
import { createPrivacyAwareIterator } from '../../shared/privacy-iterator';
import { SocialEntityTypeSchema } from '../../../../validation/schemas';

function startSubscription(entityType: string, entityId: string, ctx = {} as ConnectionContext) {
  return socialCommentSubscriptions.commentUpdates.subscribe(undefined, { entityType, entityId }, ctx);
}

describe('commentUpdates subscription — entityType validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts every SocialEntityType the schema allows (incl. session and gym)', async () => {
    // Guard against a future regression: session and gym must stay in the enum.
    expect(SocialEntityTypeSchema.options).toContain('session');
    expect(SocialEntityTypeSchema.options).toContain('gym');

    for (const entityType of SocialEntityTypeSchema.options) {
      const subscription = startSubscription(entityType, 'entity-123');
      // Passing validation lets the generator reach the (mocked, empty)
      // iterator and complete without throwing "Invalid entity type".
      await expect(subscription.next()).resolves.toEqual({ value: undefined, done: true });
      expect(vi.mocked(createPrivacyAwareIterator)).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();
    }
  });

  it('rejects an entityType outside the schema and never opens a channel', async () => {
    const subscription = startSubscription('user', 'entity-123');
    await expect(subscription.next()).rejects.toThrow('Invalid entity type: user');
    expect(vi.mocked(createPrivacyAwareIterator)).not.toHaveBeenCalled();
  });

  it('rejects an empty or over-long entityId before opening a channel', async () => {
    const empty = startSubscription('session', '');
    await expect(empty.next()).rejects.toThrow('Invalid entity ID');

    const tooLong = startSubscription('session', 'x'.repeat(257));
    await expect(tooLong.next()).rejects.toThrow('Invalid entity ID');

    expect(vi.mocked(createPrivacyAwareIterator)).not.toHaveBeenCalled();
  });
});

describe('commentUpdates subscription — deleted comments', () => {
  const TICK_OWNER = 'comment-sub-tick-owner';
  const PRIVATE_CLIMBER = 'comment-sub-private-climber';
  const REPLIER = 'comment-sub-replier';
  const STRANGER = 'comment-sub-stranger';
  const CLIMB_UUID = 'comment-sub-catalog-climb';
  const TICK_UUID = 'comment-sub-tick';
  // A private climber's comment someone replied to (soft-deleted, the row stays)
  // and one nobody replied to (hard-deleted, only the tombstone is left).
  const REPLIED_TO = 'comment-sub-replied-to';
  const UNANSWERED = 'comment-sub-unanswered';

  const viewer = (userId: string | null): ConnectionContext =>
    ({ connectionId: `comment-sub-${userId ?? 'anon'}`, isAuthenticated: !!userId, userId }) as ConnectionContext;

  async function deliveredDeletions(userId: string | null): Promise<string[]> {
    const streamsBefore = vi.mocked(createPrivacyAwareIterator).mock.calls.length;
    const subscription = startSubscription('tick', TICK_UUID, viewer(userId));
    const delivered: string[] = [];
    for await (const { commentUpdates } of subscription) {
      if (commentUpdates.__typename === 'CommentDeleted') delivered.push(commentUpdates.commentUuid);
    }
    // The tick is public, so every viewer's stream opens: an empty result is the
    // per-event check, not a refused subscription.
    expect(vi.mocked(createPrivacyAwareIterator).mock.calls.length).toBe(streamsBefore + 1);
    return delivered.sort();
  }

  beforeAll(async () => {
    harness.real = true;
    await db
      .insert(dbSchema.users)
      .values(
        [TICK_OWNER, PRIVATE_CLIMBER, REPLIER, STRANGER].map((id) => ({ id, email: `${id}@test.com`, name: id })),
      );
    await db.insert(dbSchema.userProfiles).values({ userId: PRIVATE_CLIMBER, isPrivate: true, privacyRevision: 1 });
    await db.insert(dbSchema.boardClimbs).values({
      uuid: CLIMB_UUID,
      boardType: 'kilter',
      layoutId: 1,
      name: 'Subscription privacy catalogue climb',
      isListed: true,
      isDraft: false,
      frames: 'p1r1',
    });
    await db.insert(dbSchema.boardseshTicks).values({
      uuid: TICK_UUID,
      userId: TICK_OWNER,
      climbUuid: CLIMB_UUID,
      boardType: 'kilter',
      angle: 40,
      status: 'send',
      climbedAt: '2026-10-01T10:00:00Z',
    });
    const [repliedTo] = await db
      .insert(dbSchema.comments)
      .values([
        { uuid: REPLIED_TO, userId: PRIVATE_CLIMBER, entityType: 'tick', entityId: TICK_UUID, body: 'Psyched' },
        { uuid: UNANSWERED, userId: PRIVATE_CLIMBER, entityType: 'tick', entityId: TICK_UUID, body: 'Again tomorrow' },
      ])
      .returning();
    await db.insert(dbSchema.comments).values({
      uuid: 'comment-sub-reply',
      userId: REPLIER,
      entityType: 'tick',
      entityId: TICK_UUID,
      parentCommentId: repliedTo.id,
      body: 'Same here',
    });
  });

  afterAll(() => {
    harness.real = false;
    harness.published = [];
    harness.events = [];
  });

  it('reaches the tick owner and the reply author, not a stranger, when a private climber deletes', async () => {
    harness.published = [];
    for (const commentUuid of [REPLIED_TO, UNANSWERED]) {
      await socialCommentMutations.deleteComment(null, { commentUuid }, viewer(PRIVATE_CLIMBER));
    }
    harness.events = harness.published;
    expect(harness.events).toEqual([
      expect.objectContaining({ __typename: 'CommentDeleted', commentUuid: REPLIED_TO, authorUserId: PRIVATE_CLIMBER }),
      expect.objectContaining({ __typename: 'CommentDeleted', commentUuid: UNANSWERED, authorUserId: PRIVATE_CLIMBER }),
    ]);

    // The tick's owner hears about both, including the row that is gone.
    expect(await deliveredDeletions(TICK_OWNER)).toEqual([REPLIED_TO, UNANSWERED].sort());
    // Whoever replied hears about the comment they answered, and only that one.
    expect(await deliveredDeletions(REPLIER)).toEqual([REPLIED_TO]);
    // A stranger and an anonymous viewer get nothing from a private climber.
    expect(await deliveredDeletions(STRANGER)).toEqual([]);
    expect(await deliveredDeletions(null)).toEqual([]);
    expect(await deliveredDeletions(PRIVATE_CLIMBER)).toEqual([REPLIED_TO, UNANSWERED].sort());
  });
});
