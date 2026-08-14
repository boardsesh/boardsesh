import { describe, it, expect } from 'vitest';
import type { GroupedNotification, NotificationType } from '@boardsesh/shared-schema';
import { iconMap } from '../../icon-map';
import { actorSummary, notificationCopy, notificationIconName } from '../notification-copy';

// Pure module: no jsdom, no mocks. The table below is the contract against web's
// `notification-item.tsx` — if either side drifts, the two apps say different
// things about the same notification.

const FALLBACKS = { primary: 'Someone', secondary: 'someone' };

function makeNotification(overrides: Partial<GroupedNotification> = {}): GroupedNotification {
  return {
    uuid: 'n1',
    type: 'new_follower',
    entityType: null,
    entityId: null,
    actorCount: 1,
    actors: [{ id: 'u1', displayName: 'Alex', avatarUrl: null }],
    commentBody: null,
    climbName: null,
    climbUuid: null,
    boardType: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  } as GroupedNotification;
}

/** Every type in the `NotificationType` union, so a new one can't slip past. */
const ALL_TYPES: NotificationType[] = [
  'comment_on_climb',
  'comment_on_tick',
  'comment_reply',
  'gym_claim_approved',
  'new_climb',
  'new_climb_global',
  'new_climbs_synced',
  'new_follower',
  'proposal_approved',
  'proposal_created',
  'proposal_rejected',
  'proposal_vote',
  'vote_on_comment',
  'vote_on_tick',
];

describe('notificationCopy', () => {
  // Bare branches — no commentBody, no setterUsername, no gymName. Keys are the
  // exact ones web's getNotificationText returns for the same input.
  const bareCases: Array<[NotificationType, string]> = [
    ['new_follower', 'items.newFollower'],
    ['comment_reply', 'items.commentReply'],
    ['comment_on_tick', 'items.commentOnTick'],
    ['comment_on_climb', 'items.commentOnClimb'],
    ['vote_on_tick', 'items.voteOnTick'],
    ['vote_on_comment', 'items.voteOnComment'],
    ['proposal_created', 'items.proposalCreated'],
    ['proposal_approved', 'items.proposalApproved'],
    ['proposal_rejected', 'items.proposalRejected'],
    ['proposal_vote', 'items.proposalVote'],
    ['new_climb', 'items.newClimb'],
    ['new_climb_global', 'items.newClimb'],
    ['new_climbs_synced', 'items.newClimbsSynced'],
    ['gym_claim_approved', 'items.gymClaimApprovedGeneric'],
  ];

  it.each(bareCases)('maps %s to %s', (type, expectedKey) => {
    expect(notificationCopy(makeNotification({ type }), 'Alex').textI18nKey).toBe(expectedKey);
  });

  it('covers every NotificationType in the union', () => {
    expect(bareCases.map(([type]) => type).sort()).toEqual([...ALL_TYPES].sort());
  });

  // The three comment types swap to a *WithBody key when the group carries a
  // comment preview, and interpolate the body.
  const withBodyCases: Array<[NotificationType, string]> = [
    ['comment_reply', 'items.commentReplyWithBody'],
    ['comment_on_tick', 'items.commentOnTickWithBody'],
    ['comment_on_climb', 'items.commentOnClimbWithBody'],
  ];

  it.each(withBodyCases)('maps %s with a commentBody to %s', (type, expectedKey) => {
    const copy = notificationCopy(makeNotification({ type, commentBody: 'nice send' }), 'Alex');
    expect(copy).toEqual({ textI18nKey: expectedKey, params: { actor: 'Alex', body: 'nice send' } });
  });

  it('prefers the setter key when new_climbs_synced carries a setterUsername', () => {
    const copy = notificationCopy(makeNotification({ type: 'new_climbs_synced', setterUsername: 'setterbot' }), 'Alex');
    expect(copy).toEqual({ textI18nKey: 'items.newClimbsSyncedSetter', params: { setter: 'setterbot' } });
  });

  it('names the gym when gym_claim_approved carries one', () => {
    const copy = notificationCopy(makeNotification({ type: 'gym_claim_approved', gymName: 'Boulder Barn' }), 'Alex');
    expect(copy).toEqual({ textI18nKey: 'items.gymClaimApproved', params: { gym: 'Boulder Barn' } });
  });

  it('falls back to items.default for a type the client does not know', () => {
    // A server that ships a new notification type before the app updates must
    // still render a row rather than a blank line.
    const unknown = makeNotification({ type: 'something_new' as NotificationType });
    expect(notificationCopy(unknown, 'Alex').textI18nKey).toBe('items.default');
  });
});

describe('actorSummary', () => {
  it('falls back when there are no actors', () => {
    expect(actorSummary({ actors: [], actorCount: 0 }, FALLBACKS)).toEqual({ kind: 'literal', text: 'Someone' });
  });

  it('returns the bare name for a single actor', () => {
    const summary = actorSummary(
      { actors: [{ id: 'u1', displayName: 'Alex', avatarUrl: null }], actorCount: 1 },
      FALLBACKS,
    );
    expect(summary).toEqual({ kind: 'literal', text: 'Alex' });
  });

  it('substitutes the primary fallback for a nameless single actor', () => {
    const summary = actorSummary(
      { actors: [{ id: 'u1', displayName: null, avatarUrl: null }], actorCount: 1 },
      FALLBACKS,
    );
    expect(summary).toEqual({ kind: 'literal', text: 'Someone' });
  });

  it('pairs two named actors', () => {
    const summary = actorSummary(
      {
        actors: [
          { id: 'u1', displayName: 'Alex', avatarUrl: null },
          { id: 'u2', displayName: 'Sam', avatarUrl: null },
        ],
        actorCount: 2,
      },
      FALLBACKS,
    );
    expect(summary).toEqual({ kind: 'key', textI18nKey: 'actorSummary.two', params: { first: 'Alex', second: 'Sam' } });
  });

  it('uses the secondary fallback for a nameless second actor', () => {
    const summary = actorSummary(
      {
        actors: [
          { id: 'u1', displayName: 'Alex', avatarUrl: null },
          { id: 'u2', displayName: null, avatarUrl: null },
        ],
        actorCount: 2,
      },
      FALLBACKS,
    );
    expect(summary.kind === 'key' && summary.params.second).toBe('someone');
  });

  it('uses manyOne when exactly one other actor is hidden', () => {
    const summary = actorSummary(
      { actors: [{ id: 'u1', displayName: 'Alex', avatarUrl: null }], actorCount: 2 },
      FALLBACKS,
    );
    // actorCount 2 but only one actor loaded — web takes the othersCount branch
    // here, not the `two` branch, because `actors.length >= 2` fails.
    expect(summary).toEqual({ kind: 'key', textI18nKey: 'actorSummary.manyOne', params: { first: 'Alex' } });
  });

  it('counts the remainder for three or more actors', () => {
    const summary = actorSummary(
      {
        actors: [
          { id: 'u1', displayName: 'Alex', avatarUrl: null },
          { id: 'u2', displayName: 'Sam', avatarUrl: null },
          { id: 'u3', displayName: 'Kim', avatarUrl: null },
        ],
        actorCount: 5,
      },
      FALLBACKS,
    );
    expect(summary).toEqual({ kind: 'key', textI18nKey: 'actorSummary.many', params: { first: 'Alex', count: 4 } });
  });
});

describe('notificationIconName', () => {
  it.each(ALL_TYPES)('returns a real iconMap key for %s', (type) => {
    // A typo here ships a row with no glyph, which no type error would catch.
    expect(iconMap[notificationIconName(type)]).toBeDefined();
  });

  it('groups the icons the way web does', () => {
    expect(notificationIconName('comment_reply')).toBe(notificationIconName('comment_on_climb'));
    expect(notificationIconName('vote_on_tick')).toBe(notificationIconName('vote_on_comment'));
    expect(notificationIconName('proposal_created')).toBe(notificationIconName('proposal_vote'));
    expect(notificationIconName('new_climb')).toBe(notificationIconName('new_climb_global'));
    expect(notificationIconName('new_follower')).not.toBe(notificationIconName('gym_claim_approved'));
  });

  it('falls back to the bell for an unknown type', () => {
    expect(notificationIconName('something_new' as NotificationType)).toBe('notification');
  });
});
