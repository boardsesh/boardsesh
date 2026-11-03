import { describe, expect, it } from 'vitest';
import {
  detectMoonboardLinkMode,
  nextDetectedMoonboardLinkMode,
  resolveMoonboardLinkMode,
} from '../moonboard-link-mode';

describe('resolveMoonboardLinkMode', () => {
  it('returns null for boards that are not MoonBoards', () => {
    expect(resolveMoonboardLinkMode({ boardType: 'kilter', moonboardLinkMode: 'relay' })).toBeNull();
  });

  it("prefers the person's choice over detection", () => {
    expect(
      resolveMoonboardLinkMode({ boardType: 'moonboard', moonboardLinkMode: 'multi', moonboardLinkDetected: 'relay' }),
    ).toEqual({ mode: 'multi', source: 'person' });
  });

  it('uses detection when no one chose', () => {
    expect(resolveMoonboardLinkMode({ boardType: 'moonboard', moonboardLinkDetected: 'multi' })).toEqual({
      mode: 'multi',
      source: 'detected',
    });
  });

  it('defaults to Relay mode for undetected boards', () => {
    expect(resolveMoonboardLinkMode({ boardType: 'moonboard' })).toEqual({ mode: 'relay', source: 'default' });
    expect(
      resolveMoonboardLinkMode({ boardType: 'moonboard', moonboardLinkMode: 'bogus', moonboardLinkDetected: null }),
    ).toEqual({ mode: 'relay', source: 'default' });
  });
});

describe('detectMoonboardLinkMode', () => {
  it.each([
    [8, 'relay'],
    [10, 'relay'],
    [12, 'multi'],
    [4, 'multi'],
    [14, 'multi'],
    [2, null],
    [0, null],
    [null, null],
    [undefined, null],
    [8.5, null],
  ] as const)('properties %s → %s', (properties, expected) => {
    expect(detectMoonboardLinkMode(properties)).toBe(expected);
  });
});

describe('nextDetectedMoonboardLinkMode', () => {
  it('stores the first detection', () => {
    expect(nextDetectedMoonboardLinkMode(null, 'multi')).toBe('multi');
    expect(nextDetectedMoonboardLinkMode(undefined, 'relay')).toBe('relay');
  });

  it('moves multi toward relay', () => {
    expect(nextDetectedMoonboardLinkMode('multi', 'relay')).toBe('relay');
  });

  it('never moves relay back to multi', () => {
    expect(nextDetectedMoonboardLinkMode('relay', 'multi')).toBeNull();
  });

  it('is a no-op for the same value', () => {
    expect(nextDetectedMoonboardLinkMode('multi', 'multi')).toBeNull();
  });
});
