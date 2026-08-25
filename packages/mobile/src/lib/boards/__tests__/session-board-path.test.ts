import { describe, it, expect } from 'vitest';
import { buildSessionBoardPath, type SessionBoardPathSource } from '../session-board-path';

const gymWall: SessionBoardPathSource = {
  boardType: 'moonboard',
  layoutId: 3,
  sizeId: 1,
  setIds: '5,6',
  angle: 40,
  slug: 'rocodromo-norte-moonboard',
  gymId: 12,
};

const homeWall: SessionBoardPathSource = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 30,
  slug: 'marcos-garage',
  gymId: null,
};

describe('buildSessionBoardPath', () => {
  it('names a gym wall so every joiner adopts the same board row', () => {
    // The tuple shape mints a joiner their own private row, bound to a different
    // board-presence id. Under Bluetooth both phones re-converged on connect; a
    // wall with no light kit has no such event, so the path is all there is.
    expect(buildSessionBoardPath(gymWall)).toBe('/b/rocodromo-norte-moonboard/40');
  });

  it('keeps a personal board on the positional tuple', () => {
    expect(buildSessionBoardPath(homeWall)).toBe('kilter/1/10/1,20/30');
  });

  it('carries an angle override, so an angle change keeps a gym wall named', () => {
    // The regression that would otherwise land: the play drawer rebuilds the
    // session path on every angle change, and a tuple there un-converges
    // everyone who joins afterwards.
    expect(buildSessionBoardPath(gymWall, 25)).toBe('/b/rocodromo-norte-moonboard/25');
    expect(buildSessionBoardPath(homeWall, 25)).toBe('kilter/1/10/1,20/25');
  });

  it('falls back to the tuple when a gym board has no usable slug', () => {
    // `/b//40` parses as the slug "40" — a silently broken join.
    expect(buildSessionBoardPath({ ...gymWall, slug: '' })).toBe('moonboard/3/1/5,6/40');
    expect(buildSessionBoardPath({ ...gymWall, slug: null })).toBe('moonboard/3/1/5,6/40');
  });

  it('uses gymId, not isPublic, to decide — private joiner rows default to public', () => {
    expect(buildSessionBoardPath({ ...gymWall, gymId: null })).toBe('moonboard/3/1/5,6/40');
  });
});
