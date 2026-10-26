import { describe, it, expect } from 'vitest';
import { boardReturnToRoute, resolveBoardReturnTo, setterPlaylistReturnTo } from '../board-return-to';

describe('resolveBoardReturnTo', () => {
  it.each([
    ['climbs', 'accountless'],
    ['climbs', 'Émilie & friends'],
    ['discover', 'accountless'],
    ['discover', 'Émilie & friends'],
  ] as const)('returns to the requested %s setter %s', (tab, username) => {
    const destination = setterPlaylistReturnTo(username, tab);
    expect(destination.startsWith(`/(tabs)/${tab}/setter/`)).toBe(true);
    expect(resolveBoardReturnTo(destination)).toBe(destination);
    expect(decodeURIComponent(destination.split('/').at(-1)!)).toBe(username);
  });
  it.each(['climbs', 'discover'])('rejects an invalid %s setter return segment', (tab) => {
    for (const segment of [
      '',
      '..',
      '%2E%2E',
      '..%2F..%2Fsettings',
      'alice/../settings',
      'alice?next=settings',
      '%bad',
    ]) {
      expect(resolveBoardReturnTo(`/(tabs)/${tab}/setter/${segment}`)).toBe('/(tabs)/climbs');
    }
  });
  it('does not accept a setter return from a tab without a setter route', () => {
    expect(resolveBoardReturnTo('/(tabs)/home/setter/alice')).toBe('/(tabs)/climbs');
    expect(resolveBoardReturnTo('/(tabs)/profile/setter/alice')).toBe('/(tabs)/climbs');
  });
  it('names a setter return by its route pattern, never the username', () => {
    expect(boardReturnToRoute(setterPlaylistReturnTo('alice', 'climbs'))).toBe('/(tabs)/climbs/setter/[username]');
    expect(boardReturnToRoute(setterPlaylistReturnTo('alice', 'discover'))).toBe('/(tabs)/discover/setter/[username]');
    expect(boardReturnToRoute('/(tabs)/discover')).toBe('/(tabs)/discover');
  });
  it('defaults to climbs for undefined', () => {
    expect(resolveBoardReturnTo(undefined)).toBe('/(tabs)/climbs');
  });

  it('returns discover for the exact allow-listed discover route', () => {
    expect(resolveBoardReturnTo('/(tabs)/discover')).toBe('/(tabs)/discover');
  });

  it('returns to Session after a board change initiated there', () => {
    expect(resolveBoardReturnTo('/(tabs)/record')).toBe('/(tabs)/record');
  });

  it('returns to the player after a board change from its side panel', () => {
    expect(resolveBoardReturnTo('/play')).toBe('/play');
    expect(resolveBoardReturnTo('/play/extra')).toBe('/(tabs)/climbs');
  });

  it('returns to Home after a board change from its board card', () => {
    expect(resolveBoardReturnTo('/(tabs)/home')).toBe('/(tabs)/home');
  });

  it.each(['/(tabs)/home/notifications', '/(tabs)/home/', '/(tabs)/home?next=/settings'])(
    'rejects a modified Home return route: %s',
    (route) => {
      expect(resolveBoardReturnTo(route)).toBe('/(tabs)/climbs');
    },
  );

  it.each(['/(tabs)/record/../settings', '/(tabs)/record/', ' /(tabs)/record', '/(tabs)/record?next=/settings'])(
    'rejects a modified Session return route: %s',
    (route) => {
      expect(resolveBoardReturnTo(route)).toBe('/(tabs)/climbs');
    },
  );

  it('returns climbs for the climbs route (already the default)', () => {
    expect(resolveBoardReturnTo('/(tabs)/climbs')).toBe('/(tabs)/climbs');
  });

  it('returns climbs for an arbitrary unknown route', () => {
    expect(resolveBoardReturnTo('/settings')).toBe('/(tabs)/climbs');
    expect(resolveBoardReturnTo('/evil')).toBe('/(tabs)/climbs');
  });

  it('returns climbs for an empty string', () => {
    expect(resolveBoardReturnTo('')).toBe('/(tabs)/climbs');
  });

  it('does not allow path-traversal variants of the discover route', () => {
    expect(resolveBoardReturnTo('/(tabs)/discover/../settings')).toBe('/(tabs)/climbs');
    expect(resolveBoardReturnTo('/(tabs)/discover/')).toBe('/(tabs)/climbs');
    expect(resolveBoardReturnTo(' /(tabs)/discover')).toBe('/(tabs)/climbs');
  });
});
