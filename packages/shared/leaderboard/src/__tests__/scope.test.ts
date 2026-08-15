import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SCOPE,
  RANKED_BOARD_TYPES,
  SCOPE_KINDS,
  fallbackKinds,
  isRankedBoardType,
  isValidScope,
  layoutScopeKey,
  parseLayoutScopeKey,
  scopeDefinition,
  scopeToId,
  type ScopeKind,
} from '../scope';

describe('scope registry', () => {
  it('defines every registered kind', () => {
    for (const kind of SCOPE_KINDS) {
      const definition = scopeDefinition(kind);
      expect(definition.kind).toBe(kind);
      expect(definition.labelKey).toMatch(/^standings\.scope\./);
      expect(definition.coverage).toBeGreaterThan(0);
      expect(definition.coverage).toBeLessThanOrEqual(1);
    }
  });

  it('only global has no parent, so every ladder terminates', () => {
    for (const kind of SCOPE_KINDS) {
      const ladder = fallbackKinds(kind);
      if (kind === 'global') {
        expect(ladder).toEqual([]);
      } else {
        expect(ladder.at(-1)).toBe('global');
      }
    }
  });

  it('falls a board back to its setup rather than straight to the board type', () => {
    // "Every Kilter Original at this angle" is much closer to what the climber
    // was looking at than "every Kilter anywhere".
    expect(fallbackKinds('board')).toEqual(['layout', 'boardType', 'global']);
    expect(fallbackKinds('gym')).toEqual(['layout', 'boardType', 'global']);
  });

  it('cannot loop, even if a future entry points at itself', () => {
    // fallbackKinds guards on visited kinds; assert it terminates for all.
    for (const kind of SCOPE_KINDS) {
      expect(fallbackKinds(kind).length).toBeLessThan(SCOPE_KINDS.length + 1);
    }
  });

  it('records the measured attribution coverage per kind', () => {
    // These drive the reader-facing caveat ("sends synced from the Kilter app
    // don't carry a wall"), so a wrong number here is a wrong explanation.
    expect(scopeDefinition('global').coverage).toBe(1);
    expect(scopeDefinition('boardType').coverage).toBe(1);
    expect(scopeDefinition('layout').coverage).toBeGreaterThan(0.99);
    expect(scopeDefinition('board').coverage).toBeLessThan(0.9);
    expect(scopeDefinition('gym').coverage).toBeLessThan(0.5);
  });
});

describe('scope validity', () => {
  it('requires a key for every kind except global', () => {
    expect(isValidScope(GLOBAL_SCOPE)).toBe(true);
    expect(isValidScope({ kind: 'global', key: 'something' })).toBe(false);
    expect(isValidScope({ kind: 'layout', key: 'kilter:1' })).toBe(true);
    expect(isValidScope({ kind: 'layout', key: '' })).toBe(false);
  });

  it('rejects an unregistered kind', () => {
    expect(isValidScope({ kind: 'serial' as ScopeKind, key: 'abc' })).toBe(false);
  });
});

describe('board types', () => {
  it('registers only the three with a real population', () => {
    // decoy (6 climbers in 30 days), touchstone (2) and grasshopper (1) would
    // each render a permanently dead tab.
    expect([...RANKED_BOARD_TYPES]).toEqual(['kilter', 'tension', 'moonboard']);
    expect(isRankedBoardType('kilter')).toBe(true);
    expect(isRankedBoardType('decoy')).toBe(false);
    expect(isRankedBoardType('touchstone')).toBe(false);
  });
});

describe('layout scope keys', () => {
  it('round-trips', () => {
    expect(parseLayoutScopeKey(layoutScopeKey('kilter', 1))).toEqual({ boardType: 'kilter', layoutId: 1 });
    expect(parseLayoutScopeKey(layoutScopeKey('moonboard', 17))).toEqual({ boardType: 'moonboard', layoutId: 17 });
  });

  it('rejects malformed keys instead of returning a half-parsed scope', () => {
    expect(parseLayoutScopeKey('')).toBeNull();
    expect(parseLayoutScopeKey('kilter')).toBeNull();
    expect(parseLayoutScopeKey(':1')).toBeNull();
    expect(parseLayoutScopeKey('kilter:')).toBeNull();
    expect(parseLayoutScopeKey('kilter:abc')).toBeNull();
    expect(parseLayoutScopeKey('kilter:0')).toBeNull();
    expect(parseLayoutScopeKey('kilter:1.5')).toBeNull();
  });
});

describe('scopeToId', () => {
  it('is stable and distinguishes kinds sharing a key', () => {
    expect(scopeToId(GLOBAL_SCOPE)).toBe('global');
    expect(scopeToId({ kind: 'board', key: '42' })).toBe('board:42');
    expect(scopeToId({ kind: 'gym', key: '42' })).not.toBe(scopeToId({ kind: 'board', key: '42' }));
  });
});
