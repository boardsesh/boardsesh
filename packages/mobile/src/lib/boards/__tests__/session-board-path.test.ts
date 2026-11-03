import { describe, it, expect } from 'vitest';
import {
  buildAngleChangeSessionBoardPath,
  buildSessionBoardPath,
  type SessionBoardPathSource,
} from '../session-board-path';

const gymWall: SessionBoardPathSource = {
  boardType: 'moonboard',
  layoutId: 3,
  sizeId: 1,
  setIds: '5,6',
  angle: 40,
  slug: 'rocodromo-norte-moonboard',
};

const homeWall: SessionBoardPathSource = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 30,
  slug: 'marcos-garage',
};

describe('buildSessionBoardPath', () => {
  it('names a gym wall so every joiner adopts the same board row', () => {
    // The tuple shape mints a joiner their own private row, bound to a different
    // board-presence id. Under Bluetooth both phones re-converged on connect; a
    // wall with no light kit has no such event, so the path is all there is.
    expect(buildSessionBoardPath(gymWall)).toBe('/b/rocodromo-norte-moonboard/40');
  });

  it('names a home wall too, so the crew lands on the owner’s board and sees its holder (#7220)', () => {
    expect(buildSessionBoardPath(homeWall)).toBe('/b/marcos-garage/30');
  });

  it('carries an angle override, so an angle change keeps the wall named', () => {
    // The regression that would otherwise land: the play drawer rebuilds the
    // session path on every angle change, and a tuple there un-converges
    // everyone who joins afterwards.
    expect(buildSessionBoardPath(gymWall, 25)).toBe('/b/rocodromo-norte-moonboard/25');
    expect(buildSessionBoardPath(homeWall, 25)).toBe('/b/marcos-garage/25');
    expect(buildSessionBoardPath(homeWall, 0)).toBe('/b/marcos-garage/0');
  });

  it('falls back to the tuple when a board has no usable slug', () => {
    // `/b//40` parses as the slug "40" — a silently broken join.
    expect(buildSessionBoardPath({ ...gymWall, slug: '' })).toBe('moonboard/3/1/5,6/40');
    expect(buildSessionBoardPath({ ...gymWall, slug: null })).toBe('moonboard/3/1/5,6/40');
    expect(buildSessionBoardPath({ ...homeWall, slug: undefined }, 25)).toBe('kilter/1/10/1,20/25');
  });

  it('never names a shared per-config feed, which stands for every wall with that config', () => {
    expect(buildSessionBoardPath({ ...gymWall, slug: 'presence-moonboard-3-1-0123456789abcdef0123' })).toBe(
      'moonboard/3/1/5,6/40',
    );
  });
});

describe('buildAngleChangeSessionBoardPath', () => {
  it('keeps naming the wall the session already names, or a session with no path yet', () => {
    expect(buildAngleChangeSessionBoardPath(homeWall, 25, '/b/marcos-garage/30')).toBe('/b/marcos-garage/25');
    expect(buildAngleChangeSessionBoardPath(homeWall, 25, '')).toBe('/b/marcos-garage/25');
  });

  it('sends a crewmate’s own home board as a tuple, so the session stays on the host’s wall', () => {
    // The host's wall reached this crewmate as geometry, or they never moved onto it.
    expect(buildAngleChangeSessionBoardPath(homeWall, 25, 'kilter/1/10/1,20/30')).toBe('kilter/1/10/1,20/25');
    expect(buildAngleChangeSessionBoardPath(homeWall, 25, '/b/sams-garage/30')).toBe('kilter/1/10/1,20/25');
  });

  it('always names a gym or ledless wall, as before, so a session converges on it', () => {
    expect(buildAngleChangeSessionBoardPath({ ...gymWall, gymId: 12 }, 25, 'moonboard/3/1/5,6/40')).toBe(
      '/b/rocodromo-norte-moonboard/25',
    );
    expect(buildAngleChangeSessionBoardPath({ ...homeWall, hasLeds: false }, 25, '/b/sams-garage/30')).toBe(
      '/b/marcos-garage/25',
    );
  });

  it('keeps the tuple for a board with no slug', () => {
    expect(buildAngleChangeSessionBoardPath({ ...homeWall, slug: null }, 25, '')).toBe('kilter/1/10/1,20/25');
  });
});
