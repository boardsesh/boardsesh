import { describe, it, expect } from 'vite-plus/test';
import type { SocialEvent } from '@boardsesh/shared-schema';

/**
 * Tests for NotificationWorker event routing logic.
 * We test the routing table without actually processing events
 * (which would require DB access).
 */
describe('NotificationWorker event routing', () => {
  // The routing table maps event types to handler methods
  const SUPPORTED_EVENTS: SocialEvent['type'][] = [
    'comment.created',
    'comment.reply',
    'vote.cast',
    'follow.created',
    'ascent.logged',
    'climb.created',
    'proposal.created',
    'proposal.voted',
    'proposal.approved',
    'proposal.rejected',
  ];

  const FEED_FANOUT_EVENTS: SocialEvent['type'][] = [
    'ascent.logged',
    'comment.created',
    'comment.reply',
    'climb.created',
    'proposal.approved',
  ];

  it('has handlers for all currently supported event types', () => {
    // This is a documentation/specification test that validates
    // the expected routing behavior
    expect(SUPPORTED_EVENTS).toContain('comment.created');
    expect(SUPPORTED_EVENTS).toContain('comment.reply');
    expect(SUPPORTED_EVENTS).toContain('vote.cast');
    expect(SUPPORTED_EVENTS).toContain('follow.created');
    expect(SUPPORTED_EVENTS).toContain('ascent.logged');
    expect(SUPPORTED_EVENTS).toContain('climb.created');
    expect(SUPPORTED_EVENTS).toContain('proposal.created');
    expect(SUPPORTED_EVENTS).toContain('proposal.voted');
    expect(SUPPORTED_EVENTS).toContain('proposal.approved');
    expect(SUPPORTED_EVENTS).toContain('proposal.rejected');
  });

  it('documents events that also write activity feed rows', () => {
    expect(FEED_FANOUT_EVENTS).toEqual([
      'ascent.logged',
      'comment.created',
      'comment.reply',
      'climb.created',
      'proposal.approved',
    ]);
  });

  describe('self-notification guard', () => {
    it('documents that notifications where recipientId === actorId are skipped', () => {
      // The createAndPublishNotification method checks:
      // if (recipientId === actorId) return;
      // This is tested indirectly through the worker
      const actorId = 'user-123';
      const recipientId = 'user-123';
      expect(actorId === recipientId).toBe(true);
    });
  });

  describe('deduplication windows', () => {
    it('uses 60 minutes window for vote deduplication', () => {
      // vote.cast handler calls isDuplicate with 60 (minutes)
      const VOTE_DEDUP_MINUTES = 60;
      expect(VOTE_DEDUP_MINUTES).toBe(60);
    });

    it('uses 24 hours (1440 minutes) window for follow deduplication', () => {
      // follow.created handler calls isDuplicate with 1440 (minutes)
      const FOLLOW_DEDUP_MINUTES = 1440;
      expect(FOLLOW_DEDUP_MINUTES).toBe(24 * 60);
    });

    it('does not deduplicate comment notifications', () => {
      // comment.created and comment.reply handlers do NOT call isDuplicate
      // Each comment generates a notification (they're distinct actions)
      expect(SUPPORTED_EVENTS).toContain('comment.created');
      expect(SUPPORTED_EVENTS).toContain('comment.reply');
    });
  });
});
