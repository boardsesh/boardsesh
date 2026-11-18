import { describe, expect, it } from 'vitest';
import type { LiveCardModel } from '../../live-sessions/live-session-model';
import { joinableLiveSessions, joinButtonName, joinButtonTitle, MAX_JOIN_LABEL_LENGTH } from '../session-live';

function card(sessionId: string, overrides: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    sessionId,
    startedAtMs: 0,
    host: null,
    participants: [],
    participantCount: 1,
    followedParticipantIds: [],
    viewerIsMember: false,
    boardName: null,
    boardType: null,
    gymName: null,
    angle: null,
    sendCount: 0,
    hardestSendGrade: null,
    currentClimbName: null,
    currentClimbGrade: null,
    reasons: [],
    ...overrides,
  };
}

const person = (userId: string, displayName: string | null) => ({ userId, displayName, avatarUrl: null });

describe('joinableLiveSessions', () => {
  it('drops quiet sessions and the viewer’s own, and puts followed climbers first in stable order', () => {
    const sessions = joinableLiveSessions([
      card('stranger-1'),
      card('quiet', { participantCount: 0, followedParticipantIds: ['x'] }),
      card('own', { viewerIsMember: true, followedParticipantIds: ['x'] }),
      card('friend-1', { followedParticipantIds: ['a'] }),
      card('stranger-2'),
      card('friend-2', { followedParticipantIds: ['b'] }),
    ]);
    expect(sessions.map((session) => session.sessionId)).toEqual(['friend-1', 'friend-2', 'stranger-1', 'stranger-2']);
  });
});

describe('joinButtonName', () => {
  it('names a followed climber first, by first name', () => {
    const live = card('a', {
      participants: [person('ben', 'Ben Lee'), person('anna', 'Anna Kowalski')],
      followedParticipantIds: ['anna'],
    });
    expect(joinButtonName(live, null)).toBe('Anna');
  });

  it('skips the viewer and nameless climbers, then falls back to the host', () => {
    const live = card('a', {
      host: person('host', '  Priya Nair '),
      participants: [person('me', 'Me Myself'), person('ghost', null)],
    });
    expect(joinButtonName(live, 'me')).toBe('Priya');
    expect(joinButtonName(card('b'), null)).toBeNull();
  });
});

describe('joinButtonTitle', () => {
  const withName = (name: string) => `Join ${name}`;

  it('keeps the name while the whole label fits', () => {
    expect(joinButtonTitle('Anna', withName, 'Join')).toBe('Join Anna');
    const longest = 'x'.repeat(MAX_JOIN_LABEL_LENGTH - 'Join '.length);
    expect(joinButtonTitle(longest, withName, 'Join')).toBe(`Join ${longest}`);
  });

  it('drops the name, never the verb, when the label would not fit', () => {
    expect(joinButtonTitle('Maximiliana', withName, 'Join')).toBe('Join');
    // A longer verb in another locale gets the same budget.
    expect(joinButtonTitle('Annabelle', (name) => `Rejoindre ${name}`, 'Rejoindre')).toBe('Rejoindre');
    expect(joinButtonTitle(null, withName, 'Join')).toBe('Join');
  });

  it('counts an emoji or accented letter once', () => {
    expect(joinButtonTitle('Zoë🧗', withName, 'Join')).toBe('Join Zoë🧗');
  });
});
