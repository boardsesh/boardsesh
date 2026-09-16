import { beforeAll, describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import feedEnUs from '@boardsesh/i18n/locales/en-US/feed.json';
import {
  elapsedShort,
  elapsedSpoken,
  liveBoardLine,
  liveCardSpokenLabel,
  liveNamesCopy,
  startedSpoken,
} from '../live-session-copy';
import type { LiveCardModel } from '../live-session-model';

// The real en-US catalog through a real i18next instance, so plurals and
// interpolation are exercised exactly as they render in the app.
let t: TFunction<'feed'>;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    ns: ['feed'],
    defaultNS: 'feed',
    resources: { 'en-US': { feed: feedEnUs } },
    interpolation: { escapeValue: false },
  });
  t = instance.getFixedT('en-US', 'feed') as unknown as TFunction<'feed'>;
});

function card(overrides: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    sessionId: 's1',
    startedAtMs: 0,
    host: null,
    participants: [],
    participantCount: 3,
    followedParticipantIds: [],
    viewerIsMember: false,
    boardName: 'Kilter Original',
    boardType: 'kilter',
    gymName: 'Crux Collective',
    angle: 40,
    sendCount: 7,
    hardestSendGrade: 'V6',
    currentClimbName: null,
    currentClimbGrade: null,
    reasons: ['FOLLOWING_USER'],
    ...overrides,
  };
}

describe('liveNamesCopy', () => {
  it('renders each descriptor', () => {
    expect(liveNamesCopy({ kind: 'one', name: 'Priya N.', others: 0 }, t)).toEqual({
      names: 'Priya N.',
      extra: null,
      spoken: 'Priya N.',
    });
    expect(liveNamesCopy({ kind: 'two', first: 'Priya N.', second: 'Tom R.' }, t).names).toBe('Priya N. and Tom R.');
    expect(liveNamesCopy({ kind: 'justYou' }, t).names).toBe('Just you so far');
    expect(liveNamesCopy({ kind: 'youAnd', name: 'Priya N.' }, t).names).toBe('You and Priya N.');
  });

  it('keeps "+N" separate from the names and spells it out for VoiceOver', () => {
    expect(liveNamesCopy({ kind: 'one', name: 'Priya N.', others: 3 }, t)).toEqual({
      names: 'Priya N.',
      extra: '+3',
      spoken: 'Priya N. and 3 others',
    });
    expect(liveNamesCopy({ kind: 'you', others: 1 }, t)).toEqual({
      names: 'You',
      extra: '+1',
      spoken: 'You and 1 other',
    });
  });

  it('names an unnamed climber generically', () => {
    expect(liveNamesCopy({ kind: 'one', name: null, others: 0 }, t).names).toBe('A climber');
  });
});

describe('elapsed copy', () => {
  it('formats the short form', () => {
    expect(elapsedShort({ hours: 0, minutes: 12 }, t)).toBe('12m');
    expect(elapsedShort({ hours: 1, minutes: 5 }, t)).toBe('1h 5m');
    expect(elapsedShort({ hours: 2, minutes: 0 }, t)).toBe('2h');
  });

  it('says "Just started" inside the first minute instead of a bare 0m', () => {
    expect(elapsedShort({ hours: 0, minutes: 0 }, t)).toBe('Just started');
    expect(startedSpoken({ hours: 0, minutes: 0 }, t)).toBe('just started');
    expect(startedSpoken({ hours: 0, minutes: 3 }, t)).toBe('started 3 minutes ago');
  });

  it('spells units out for VoiceOver', () => {
    expect(elapsedSpoken({ hours: 0, minutes: 12 }, t)).toBe('12 minutes');
    expect(elapsedSpoken({ hours: 0, minutes: 1 }, t)).toBe('1 minute');
    expect(elapsedSpoken({ hours: 1, minutes: 5 }, t)).toBe('1 hour 5 minutes');
    expect(elapsedSpoken({ hours: 2, minutes: 0 }, t)).toBe('2 hours');
    expect(elapsedSpoken({ hours: 0, minutes: 0 }, t)).toBe('0 minutes');
  });
});

describe('liveBoardLine', () => {
  it('uses the board name and angle', () => {
    expect(liveBoardLine(card(), t)).toBe('Kilter Original · 40°');
  });

  it('falls back to the board type display name', () => {
    expect(liveBoardLine(card({ boardName: null, boardType: 'moonboard', angle: null }), t)).toBe('MoonBoard');
    expect(liveBoardLine(card({ boardName: null, boardType: null }), t)).toBeNull();
  });
});

describe('liveCardSpokenLabel', () => {
  it('reads the whole card as one sentence', () => {
    const label = liveCardSpokenLabel(
      {
        names: { names: 'Priya N.', extra: '+2', spoken: 'Priya N. and 2 others' },
        card: card(),
        elapsed: { hours: 0, minutes: 42 },
        hardestGrade: 'V6',
        climbGrade: null,
      },
      t,
    );
    expect(label).toBe(
      'Priya N. and 2 others, live on Kilter Original at 40 degrees, Crux Collective, started 42 minutes ago, 7 sends, hardest V6',
    );
  });

  it('reads a session nobody is connected to as quiet, not live', () => {
    const label = liveCardSpokenLabel(
      {
        names: { names: 'Priya N.', extra: null, spoken: 'Priya N.' },
        card: card({ participantCount: 0, sendCount: 0, hardestSendGrade: null }),
        elapsed: { hours: 0, minutes: 12 },
        hardestGrade: null,
        climbGrade: null,
      },
      t,
    );
    expect(label).toBe('Priya N., quiet on Kilter Original at 40 degrees, Crux Collective, started 12 minutes ago');
    expect(label).not.toContain('live');
  });

  it('skips what the card does not show', () => {
    const label = liveCardSpokenLabel(
      {
        names: { names: 'Just you so far', extra: null, spoken: 'Just you so far' },
        card: card({ boardName: null, boardType: null, gymName: null, sendCount: 0, currentClimbName: 'Legion' }),
        elapsed: { hours: 1, minutes: 0 },
        hardestGrade: null,
        climbGrade: 'V3',
      },
      t,
    );
    expect(label).toBe('Just you so far, live now, On Legion · V3, started 1 hour ago');
  });
});
