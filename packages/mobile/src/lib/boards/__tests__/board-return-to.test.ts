import { describe, it, expect } from 'vitest';
import { resolveBoardReturnTo, setterPlaylistReturnTo } from '../board-return-to';

describe('resolveBoardReturnTo', () => {
  it.each(['accountless', 'Émilie & friends'])('returns to the requested setter %s', (username) => {
    const destination = setterPlaylistReturnTo(username);
    expect(resolveBoardReturnTo(destination)).toBe(destination);
    expect(decodeURIComponent(destination.split('/').at(-1)!)).toBe(username);
  });
  it.each(['', '..', '%2E%2E', '..%2F..%2Fsettings', 'alice/../settings', 'alice?next=settings', '%bad'])(
    'rejects an invalid setter return segment: %s',
    (segment) => {
      expect(resolveBoardReturnTo(`/(tabs)/climbs/setter/${segment}`)).toBe('/(tabs)/climbs');
    },
  );
  it('defaults to climbs for undefined', () => {
    expect(resolveBoardReturnTo(undefined)).toBe('/(tabs)/climbs');
  });

  it('returns discover for the exact allow-listed discover route', () => {
    expect(resolveBoardReturnTo('/(tabs)/discover')).toBe('/(tabs)/discover');
  });

  it('returns to Session after a board change initiated there', () => {
    expect(resolveBoardReturnTo('/(tabs)/record')).toBe('/(tabs)/record');
  });

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
