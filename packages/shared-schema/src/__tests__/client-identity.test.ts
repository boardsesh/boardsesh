import { describe, expect, it } from 'vitest';

import {
  CLIENT_IDENTITY_MAX_LENGTH,
  type ClientIdentity,
  formatClientIdentity,
  parseClientIdentity,
} from '../client-identity';

void describe('formatClientIdentity', () => {
  it('formats name and version only', () => {
    expect(formatClientIdentity({ name: 'boardsesh-web', version: '1.4.2' })).toBe('boardsesh-web/1.4.2');
  });

  it('formats a platform without a build', () => {
    expect(formatClientIdentity({ name: 'boardsesh-mobile-web', version: '2.6.0', platform: 'web' })).toBe(
      'boardsesh-mobile-web/2.6.0 (web)',
    );
  });

  it('formats a platform with a build', () => {
    expect(formatClientIdentity({ name: 'boardsesh-mobile', version: '2.6.0', platform: 'ios', build: '45' })).toBe(
      'boardsesh-mobile/2.6.0 (ios; build 45)',
    );
  });

  it('drops a build when no platform is given', () => {
    expect(formatClientIdentity({ name: 'boardsesh-web', version: '1.0.0', build: '7' })).toBe('boardsesh-web/1.0.0');
  });
});

void describe('parseClientIdentity', () => {
  const roundTripCases: ClientIdentity[] = [
    { name: 'boardsesh-web', version: '1.4.2' },
    { name: 'boardsesh-mobile-web', version: '2.6.0', platform: 'web' },
    { name: 'boardsesh-mobile', version: '2.6.0', platform: 'ios', build: '45' },
    { name: 'boardsesh-mobile', version: '2.6.0-beta.1', platform: 'android', build: '1234' },
  ];

  for (const identity of roundTripCases) {
    it(`round-trips ${formatClientIdentity(identity)}`, () => {
      expect(parseClientIdentity(formatClientIdentity(identity))).toEqual(identity);
    });
  }

  it('trims surrounding whitespace', () => {
    expect(parseClientIdentity('  boardsesh-web/1.4.2  ')).toEqual({ name: 'boardsesh-web', version: '1.4.2' });
  });

  it('tolerates extra spaces inside the parentheses', () => {
    expect(parseClientIdentity('boardsesh-mobile/2.6.0 ( ios ;  build 45 )')).toEqual({
      name: 'boardsesh-mobile',
      version: '2.6.0',
      platform: 'ios',
      build: '45',
    });
  });

  it('returns undefined for missing input', () => {
    expect(parseClientIdentity(undefined)).toBeUndefined();
    expect(parseClientIdentity(null)).toBeUndefined();
    expect(parseClientIdentity('')).toBeUndefined();
    expect(parseClientIdentity('   ')).toBeUndefined();
  });

  it('returns undefined for garbage', () => {
    for (const garbage of [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'boardsesh-web',
      '/1.0.0',
      'boardsesh-web/',
      '-leading-dash/1.0.0',
      'under_score/1.0.0',
      'boardsesh web/1.0.0',
      'boardsesh-web/1.0.0 extra',
      'boardsesh-web/1.0.0 ()',
      'boardsesh-web/1.0.0 (ios; nightly 45)',
      'boardsesh-web/1.0.0 (ios; build 45; extra)',
      'boardsesh-web/1.0.0 (ios; build)',
      '{"name":"boardsesh-web"}',
    ]) {
      expect(parseClientIdentity(garbage), garbage).toBeUndefined();
    }
  });

  it('returns undefined when the parentheses are not closed or opened', () => {
    expect(parseClientIdentity('boardsesh-mobile/2.6.0 (ios; build 45')).toBeUndefined();
    expect(parseClientIdentity('boardsesh-mobile/2.6.0 ios; build 45)')).toBeUndefined();
  });

  it('enforces the length cap', () => {
    const atCap = `a/${'1'.repeat(CLIENT_IDENTITY_MAX_LENGTH - 2)}`;
    expect(atCap).toHaveLength(CLIENT_IDENTITY_MAX_LENGTH);
    expect(parseClientIdentity(atCap)).toEqual({ name: 'a', version: '1'.repeat(CLIENT_IDENTITY_MAX_LENGTH - 2) });
    expect(parseClientIdentity(`${atCap}1`)).toBeUndefined();
  });

  it('never throws on non-string input smuggled past the type', () => {
    expect(parseClientIdentity(42 as unknown as string)).toBeUndefined();
    expect(parseClientIdentity({} as unknown as string)).toBeUndefined();
  });
});
