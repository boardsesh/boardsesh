import { describe, it, expect } from 'vitest';
import { resolveBoardReturnTo } from '../board-return-to';

describe('resolveBoardReturnTo', () => {
  it('defaults to climbs for undefined', () => {
    expect(resolveBoardReturnTo(undefined)).toBe('/(tabs)/climbs');
  });

  it('returns discover for the exact allow-listed discover route', () => {
    expect(resolveBoardReturnTo('/(tabs)/discover')).toBe('/(tabs)/discover');
  });

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
