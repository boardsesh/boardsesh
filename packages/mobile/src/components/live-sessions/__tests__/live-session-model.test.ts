import { describe, expect, it } from 'vitest';
import type { LiveSession } from '@boardsesh/shared-schema';
import {
  describeLiveNames,
  elapsedParts,
  isListedForFollowedBoardOnly,
  liveCardAction,
  liveTileLayout,
  orderLiveCards,
  planLiveRail,
  shortPersonName,
  toLiveCardModel,
  type LiveCardModel,
  type LiveCardPerson,
} from '../live-session-model';

function person(userId: string, displayName: string | null): LiveCardPerson {
  return { userId, displayName, avatarUrl: null };
}

function card(overrides: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    sessionId: 's1',
    startedAtMs: 0,
    host: person('host', 'Hana Host'),
    participants: [person('host', 'Hana Host')],
    participantCount: 1,
    followedParticipantIds: [],
    viewerIsMember: false,
    boardName: 'Kilter Original',
    boardType: 'kilter',
    gymName: 'Crux Collective',
    angle: 40,
    sendCount: 0,
    hardestSendGrade: null,
    currentClimbName: null,
    currentClimbGrade: null,
    reasons: ['FOLLOWING_USER'],
    ...overrides,
  };
}

describe('toLiveCardModel', () => {
  it('drops lastActivity and flattens board and climb fields', () => {
    const session: LiveSession = {
      sessionId: 's9',
      name: null,
      goal: null,
      color: null,
      startedAt: '2026-09-16T10:00:00.000Z',
      lastActivity: '2026-09-16T10:41:00.000Z',
      host: { userId: 'u1', displayName: 'Priya Nair', avatarUrl: null },
      participants: [{ userId: 'u1', displayName: 'Priya Nair', avatarUrl: null }],
      participantCount: 1,
      followedParticipantIds: ['u1'],
      viewerIsMember: false,
      isPublic: true,
      board: { uuid: 'b1', name: 'Kilter Original', slug: null, boardType: 'kilter', gymName: 'Crux' },
      boardType: 'kilter',
      angle: 40,
      sendCount: 7,
      flashCount: 2,
      hardestSendGrade: 'V6',
      currentClimb: { name: 'Legion', grade: 'V3' },
      reasons: ['FOLLOWING_USER'],
    };
    const model = toLiveCardModel(session);
    expect(model).not.toHaveProperty('lastActivity');
    expect(model.startedAtMs).toBe(Date.parse('2026-09-16T10:00:00.000Z'));
    expect(model.boardName).toBe('Kilter Original');
    expect(model.gymName).toBe('Crux');
    expect(model.currentClimbName).toBe('Legion');
    expect(model.currentClimbGrade).toBe('V3');
  });

  it('falls back to the session board type when the board is hidden', () => {
    const model = toLiveCardModel({
      sessionId: 's1',
      name: null,
      goal: null,
      color: null,
      startedAt: 'not a date',
      lastActivity: 'x',
      host: null,
      participants: [],
      participantCount: 0,
      followedParticipantIds: [],
      viewerIsMember: false,
      isPublic: true,
      board: null,
      boardType: 'tension',
      angle: null,
      sendCount: 0,
      flashCount: 0,
      hardestSendGrade: null,
      currentClimb: null,
      reasons: [],
    });
    expect(model.boardName).toBeNull();
    expect(model.boardType).toBe('tension');
    expect(model.startedAtMs).toBe(0);
  });
});

describe('orderLiveCards', () => {
  it('keeps known ids in place and appends new ones in backend order', () => {
    const first = orderLiveCards([], [card({ sessionId: 'a' }), card({ sessionId: 'b' })]);
    expect(first.map((entry) => entry.sessionId)).toEqual(['a', 'b']);

    // The backend re-sorted and a new session arrived: a and b must not swap.
    const second = orderLiveCards(
      first.map((entry) => entry.sessionId),
      [card({ sessionId: 'c' }), card({ sessionId: 'b' }), card({ sessionId: 'a' })],
    );
    expect(second.map((entry) => entry.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('drops ended sessions', () => {
    const ordered = orderLiveCards(['a', 'b', 'c'], [card({ sessionId: 'c' }), card({ sessionId: 'a' })]);
    expect(ordered.map((entry) => entry.sessionId)).toEqual(['a', 'c']);
  });

  it("always leads with the viewer's own session", () => {
    const ordered = orderLiveCards(
      ['a', 'b'],
      [card({ sessionId: 'a' }), card({ sessionId: 'b' }), card({ sessionId: 'mine', viewerIsMember: true })],
    );
    expect(ordered.map((entry) => entry.sessionId)).toEqual(['mine', 'a', 'b']);
  });
});

describe('shortPersonName', () => {
  it('abbreviates the last name', () => {
    expect(shortPersonName('Priya Nair')).toBe('Priya N.');
    expect(shortPersonName('  tom  van rijn ')).toBe('tom R.');
  });

  it('keeps handles and single names whole, and drops blanks', () => {
    expect(shortPersonName('crimpqueen')).toBe('crimpqueen');
    expect(shortPersonName('   ')).toBeNull();
    expect(shortPersonName(null)).toBeNull();
  });
});

describe('describeLiveNames', () => {
  it('names one climber', () => {
    expect(describeLiveNames(card(), 'viewer')).toEqual({ kind: 'one', name: 'Hana H.', others: 0 });
  });

  it('names two climbers when exactly two are on the roster', () => {
    const descriptor = describeLiveNames(
      card({ participants: [person('a', 'Priya Nair'), person('b', 'Tom Reed')], participantCount: 2 }),
      'viewer',
    );
    expect(descriptor).toEqual({ kind: 'two', first: 'Priya N.', second: 'Tom R.' });
  });

  it('puts followed climbers first and counts the rest against participantCount', () => {
    const descriptor = describeLiveNames(
      card({
        participants: [person('a', 'Ana Alvarez'), person('b', 'Priya Nair')],
        participantCount: 4,
        followedParticipantIds: ['b'],
      }),
      'viewer',
    );
    expect(descriptor).toEqual({ kind: 'one', name: 'Priya N.', others: 3 });
  });

  it('falls back to the host when nobody on the roster has a name', () => {
    const descriptor = describeLiveNames(card({ participants: [], participantCount: 2 }), 'viewer');
    expect(descriptor).toEqual({ kind: 'one', name: 'Hana H.', others: 1 });
  });

  it('says "Just you so far" for the viewer alone', () => {
    expect(
      describeLiveNames(
        card({ viewerIsMember: true, participants: [person('viewer', 'Me Myself')], participantCount: 1 }),
        'viewer',
      ),
    ).toEqual({ kind: 'justYou' });
  });

  it('names the one other climber in the viewer session', () => {
    expect(
      describeLiveNames(
        card({
          viewerIsMember: true,
          participants: [person('viewer', 'Me Myself'), person('a', 'Priya Nair')],
          participantCount: 2,
        }),
        'viewer',
      ),
    ).toEqual({ kind: 'youAnd', name: 'Priya N.' });
  });

  it('counts the others in a bigger viewer session', () => {
    expect(
      describeLiveNames(
        card({
          viewerIsMember: true,
          participants: [person('viewer', 'Me'), person('a', 'Priya Nair'), person('b', 'Tom Reed')],
          participantCount: 3,
        }),
        'viewer',
      ),
    ).toEqual({ kind: 'you', others: 2 });
  });
});

describe('liveCardAction', () => {
  it('offers Join only on a followed or selected board', () => {
    expect(liveCardAction(card({ reasons: ['FOLLOWED_BOARD'] }))).toBe('join');
    expect(liveCardAction(card({ reasons: ['FOLLOWING_USER', 'SELECTED_BOARD'] }))).toBe('join');
    expect(liveCardAction(card({ reasons: ['FOLLOWING_USER'] }))).toBe('open');
  });

  it('offers Invite on the viewer solo session and Open once others joined', () => {
    expect(liveCardAction(card({ viewerIsMember: true, participantCount: 1 }))).toBe('invite');
    expect(liveCardAction(card({ viewerIsMember: true, participantCount: 3 }))).toBe('open');
  });
});

describe('isListedForFollowedBoardOnly', () => {
  it('is true only without a followed climber', () => {
    expect(isListedForFollowedBoardOnly(card({ reasons: ['FOLLOWED_BOARD'] }))).toBe(true);
    expect(isListedForFollowedBoardOnly(card({ reasons: ['FOLLOWED_BOARD', 'FOLLOWING_USER'] }))).toBe(false);
    expect(isListedForFollowedBoardOnly(card({ reasons: ['SELECTED_BOARD'] }))).toBe(false);
  });
});

describe('elapsedParts', () => {
  it('splits minutes into hours and minutes, floored', () => {
    expect(elapsedParts(0, 12 * 60_000 + 59_000)).toEqual({ hours: 0, minutes: 12 });
    expect(elapsedParts(0, 65 * 60_000)).toEqual({ hours: 1, minutes: 5 });
  });

  it('never goes negative on a clock skewed ahead of now', () => {
    expect(elapsedParts(10 * 60_000, 0)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('planLiveRail', () => {
  const base = { cards: [], viewerInSession: false, followsNobody: false, startCollapsed: false };
  const kinds = (input: Parameters<typeof planLiveRail>[0]) => planLiveRail(input).entries.map((entry) => entry.kind);

  it('shows Start then Find climbers when nobody is live', () => {
    expect(kinds(base)).toEqual(['start', 'find']);
  });

  it('puts sessions first, Start last, and drops Find when the rail has sessions', () => {
    expect(kinds({ ...base, cards: [card({ sessionId: 'a' }), card({ sessionId: 'b' })] })).toEqual([
      'session',
      'session',
      'start',
    ]);
  });

  it('leads with Find climbers when the viewer follows nobody', () => {
    expect(kinds({ ...base, followsNobody: true })).toEqual(['find', 'start']);
    expect(kinds({ ...base, followsNobody: true, cards: [card({ reasons: ['FOLLOWED_BOARD'] })] })).toEqual([
      'find',
      'session',
      'start',
    ]);
  });

  it('hides Start when a session is already live on the selected board', () => {
    expect(kinds({ ...base, cards: [card({ reasons: ['SELECTED_BOARD'] })] })).toEqual(['session']);
  });

  it('hides both prompts when the viewer is in a session', () => {
    expect(kinds({ ...base, viewerInSession: true })).toEqual([]);
    expect(kinds({ ...base, followsNobody: true, cards: [card({ sessionId: 'mine', viewerIsMember: true })] })).toEqual(
      ['session'],
    );
  });

  it('collapses Start to the compact row after quiet days, only while nobody is live', () => {
    const quiet = planLiveRail({ ...base, startCollapsed: true });
    expect(quiet.compactStart).toBe(true);
    expect(quiet.showsStartTile).toBe(false);
    expect(quiet.entries).toEqual([]);

    const busy = planLiveRail({ ...base, startCollapsed: true, cards: [card()] });
    expect(busy.compactStart).toBe(false);
    expect(busy.entries.map((entry) => entry.kind)).toEqual(['session', 'start']);
  });

  it('keeps Find climbers leading beside the compact row for someone who follows nobody', () => {
    const plan = planLiveRail({ ...base, startCollapsed: true, followsNobody: true });
    expect(plan.compactStart).toBe(true);
    expect(plan.entries.map((entry) => entry.kind)).toEqual(['find']);
  });
});

describe('liveTileLayout', () => {
  it('is 192pt at default text and never smaller', () => {
    expect(liveTileLayout(1)).toEqual({ height: 192, stacked: false });
    expect(liveTileLayout(0.82)).toEqual({ height: 192, stacked: false });
  });

  it('grows with Dynamic Type and stacks the action above 1.2×', () => {
    const large = liveTileLayout(1.2);
    expect(large.stacked).toBe(false);
    expect(large.height).toBeGreaterThan(192);

    const huge = liveTileLayout(1.5);
    expect(huge.stacked).toBe(true);
    expect(huge.height).toBeGreaterThan(large.height);
    // Capped at the Text primitive's 1.5× ceiling.
    expect(liveTileLayout(3)).toEqual(huge);
  });
});
