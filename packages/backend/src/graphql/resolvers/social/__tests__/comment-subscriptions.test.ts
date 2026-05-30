/**
 * Regression tests for the commentUpdates subscription resolver (issue #2357).
 *
 * The resolver guards `entityType` against an allow-list before opening a
 * pubsub channel. That list used to be hand-rolled and silently dropped
 * 'session' and 'gym', so realtime comments on /session/:sessionId and gym
 * detail pages threw `Invalid entity type: session` on subscribe and never
 * delivered events. The fix derives the allow-list from the shared Zod enum
 * `SocialEntityTypeSchema`, so these tests lock the two lists together.
 *
 * Validation runs before any DB/Redis access, so pubsub and the async-iterator
 * helper are mocked — the resolver never touches real infrastructure here.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../../../../pubsub/index', () => ({
  pubsub: { subscribeComments: vi.fn() },
}));

// createAsyncIterator resolves to an iterable that completes immediately, so a
// subscription whose entityType passes validation finishes on the first next().
vi.mock('../../shared/async-iterators', () => ({
  createAsyncIterator: vi.fn(async () => ({
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: undefined, done: true }) };
    },
  })),
}));

import { socialCommentSubscriptions } from '../comment-subscriptions';
import { createAsyncIterator } from '../../shared/async-iterators';
import { SocialEntityTypeSchema } from '../../../../validation/schemas';

function startSubscription(entityType: string, entityId: string) {
  return socialCommentSubscriptions.commentUpdates.subscribe(
    undefined,
    { entityType, entityId },
    {} as ConnectionContext,
  );
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
      expect(vi.mocked(createAsyncIterator)).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();
    }
  });

  it('rejects an entityType outside the schema and never opens a channel', async () => {
    const subscription = startSubscription('user', 'entity-123');
    await expect(subscription.next()).rejects.toThrow('Invalid entity type: user');
    expect(vi.mocked(createAsyncIterator)).not.toHaveBeenCalled();
  });

  it('rejects an empty or over-long entityId before opening a channel', async () => {
    const empty = startSubscription('session', '');
    await expect(empty.next()).rejects.toThrow('Invalid entity ID');

    const tooLong = startSubscription('session', 'x'.repeat(257));
    await expect(tooLong.next()).rejects.toThrow('Invalid entity ID');

    expect(vi.mocked(createAsyncIterator)).not.toHaveBeenCalled();
  });
});
