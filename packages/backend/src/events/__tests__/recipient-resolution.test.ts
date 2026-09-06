import { describe, it, expect, vi } from 'vite-plus/test';
import { mergeProposalCreatedRecipients, resolveFollowRecipient } from '../recipient-resolution';
import type { RecipientInfo } from '../recipient-resolution';

// Mock the db client to avoid DATABASE_URL requirement
vi.mock('../../db/client', () => ({ db: {} }));

describe('resolveFollowRecipient', () => {
  it('returns recipient for valid follow metadata', () => {
    const result = resolveFollowRecipient({
      followedUserId: 'user-123',
    });

    expect(result).toEqual({
      recipientId: 'user-123',
      notificationType: 'new_follower',
    });
  });

  it('returns null when followedUserId is missing', () => {
    const result = resolveFollowRecipient({});
    expect(result).toBeNull();
  });

  it('returns null for empty string followedUserId', () => {
    const result = resolveFollowRecipient({ followedUserId: '' });
    expect(result).toBeNull();
  });

  it('ignores extra metadata fields', () => {
    const result = resolveFollowRecipient({
      followedUserId: 'user-456',
      extraField: 'ignored',
    });

    expect(result).toEqual({
      recipientId: 'user-456',
      notificationType: 'new_follower',
    });
  });
});

describe('mergeProposalCreatedRecipients', () => {
  const setter: RecipientInfo = { recipientId: 'setter-1', notificationType: 'proposal_on_your_climb' };
  const ticker: RecipientInfo = { recipientId: 'ticker-1', notificationType: 'proposal_created' };

  it('keeps the setter and the tickers when they are different people', () => {
    expect(mergeProposalCreatedRecipients([setter], [ticker])).toEqual([setter, ticker]);
  });

  it('gives a setter who also ticked the climb only the setter notification', () => {
    const setterAlsoTicked: RecipientInfo = { recipientId: 'setter-1', notificationType: 'proposal_created' };

    const merged = mergeProposalCreatedRecipients([setter], [setterAlsoTicked, ticker]);

    expect(merged).toEqual([setter, ticker]);
    expect(merged.filter((recipient) => recipient.recipientId === 'setter-1')).toHaveLength(1);
  });

  it('returns the tickers unchanged when the climb has no known setter', () => {
    expect(mergeProposalCreatedRecipients([], [ticker])).toEqual([ticker]);
  });

  it('returns the setters unchanged when nobody has ticked the climb', () => {
    expect(mergeProposalCreatedRecipients([setter], [])).toEqual([setter]);
  });
});
