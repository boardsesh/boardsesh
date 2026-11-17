// The board is the swipe's screen-reader element. Its value used to be set only
// in Up next ("Up next, 2 of 4"), so from Search results a swipe said nothing,
// and no screen reader ever heard the climb's name or grade.
import i18next, { type TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import deSession from '@boardsesh/i18n/locales/de/session.json';
import enSession from '@boardsesh/i18n/locales/en-US/session.json';
import esSession from '@boardsesh/i18n/locales/es/session.json';
import frSession from '@boardsesh/i18n/locales/fr/session.json';
import itSession from '@boardsesh/i18n/locales/it/session.json';
import { formatBoardClimbValue } from '../board-climb-value';

async function translatorFor(lng: string, session: object): Promise<TFunction<'session'>> {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    resources: { [lng]: { session } },
    ns: ['session'],
    defaultNS: 'session',
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance) as unknown as TFunction<'session'>;
}

let t: TFunction<'session'>;
beforeAll(async () => {
  t = await translatorFor('en-US', enSession);
});

const searchResults = { kind: 'counted', name: 'Search results', position: 5, total: 40 } as const;

describe('formatBoardClimbValue', () => {
  it('names the climb, its grade and its place in the list', () => {
    expect(
      formatBoardClimbValue({
        climbName: 'Yoshi’s Island',
        grade: 'V5',
        trackLabel: searchResults,
        t,
        locale: 'en-US',
      }),
    ).toBe('Yoshi’s Island, V5, 5 of 40');
  });

  it('groups a long list’s numbers for the language', () => {
    expect(
      formatBoardClimbValue({
        climbName: 'Low',
        grade: 'V4',
        trackLabel: { kind: 'counted', name: 'Search results', position: 1234, total: 5678 },
        t,
        locale: 'en-US',
      }),
    ).toBe('Low, V4, 1,234 of 5,678');
  });

  it('names the climb and grade where the list has no count, or there is no list', () => {
    expect(
      formatBoardClimbValue({
        climbName: 'Low',
        grade: 'V4',
        trackLabel: { kind: 'named', name: 'Projects' },
        t,
        locale: 'en-US',
      }),
    ).toBe('Low, V4');
    expect(
      formatBoardClimbValue({ climbName: 'Low', grade: 'V4', trackLabel: { kind: 'hidden' }, t, locale: 'en-US' }),
    ).toBe('Low, V4');
  });

  it('reads Up next’s stretch after the climb, which carries its own position', () => {
    expect(
      formatBoardClimbValue({
        climbName: 'Low',
        grade: 'V4',
        trackLabel: {
          kind: 'upNext',
          listName: 'Projects',
          count: { position: 2, total: 4 },
          thenListName: 'Projects',
        },
        extra: 'Up next, 2 of 4, then Projects',
        t,
        locale: 'en-US',
      }),
    ).toBe('Low, V4, Up next, 2 of 4, then Projects');
  });

  it('reads the preview note after the climb and its place', () => {
    expect(
      formatBoardClimbValue({
        climbName: 'Low',
        grade: 'V4',
        trackLabel: searchResults,
        extra: 'Preview, Up next: 4 waiting',
        t,
        locale: 'en-US',
      }),
    ).toBe('Low, V4, 5 of 40, Preview, Up next: 4 waiting');
  });

  it('never cuts a grade', () => {
    const value = formatBoardClimbValue({
      climbName: 'A climb with a name long enough to fill any line it is given',
      grade: 'V14',
      trackLabel: searchResults,
      t,
      locale: 'en-US',
    });
    expect(value).toContain(', V14, ');
  });

  it('says the climb without a grade when there is none, and only the extra without a climb', () => {
    expect(formatBoardClimbValue({ climbName: 'Low', grade: '', trackLabel: searchResults, t, locale: 'en-US' })).toBe(
      'Low, 5 of 40',
    );
    expect(
      formatBoardClimbValue({
        climbName: null,
        grade: 'V4',
        trackLabel: searchResults,
        extra: 'Up next',
        t,
        locale: 'en-US',
      }),
    ).toBe('Up next');
    expect(
      formatBoardClimbValue({ climbName: ' ', grade: 'V4', trackLabel: searchResults, t, locale: 'en-US' }),
    ).toBeUndefined();
  });

  it.each([
    ['es', esSession, 'Yoshi’s Island, V5, 5 de 40'],
    ['fr', frSession, 'Yoshi’s Island, V5, 5 sur 40'],
    ['de', deSession, 'Yoshi’s Island, V5, 5 von 40'],
    ['it', itSession, 'Yoshi’s Island, V5, 5 di 40'],
  ])('says it in %s', async (lng, session, expected) => {
    const localT = await translatorFor(lng, session);
    expect(
      formatBoardClimbValue({
        climbName: 'Yoshi’s Island',
        grade: 'V5',
        trackLabel: searchResults,
        t: localT,
        locale: lng,
      }),
    ).toBe(expected);
  });
});
