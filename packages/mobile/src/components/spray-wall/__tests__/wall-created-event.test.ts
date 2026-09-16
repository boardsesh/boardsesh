import { describe, expect, it } from 'vitest';
import { wallCreatedEventProperties, type WallBoardRow, type WallCreatedMeta } from '../wall-created-event';

// The row a wall's board payload actually carries. `locationName` and the
// coordinates are absent from it on purpose — the query does not select them.
function row(overrides: Partial<WallBoardRow> = {}): WallBoardRow {
  return { angle: 25, isPublic: false, gymUuid: null, ...overrides };
}

function meta(overrides: Partial<WallCreatedMeta> = {}): WallCreatedMeta {
  return { angle: 25, hasLocationName: true, hasCoords: true, gymUuid: 'gym-1', ...overrides };
}

describe('wallCreatedEventProperties', () => {
  it('reports a wall built in one sitting from the meta step and the row', () => {
    const properties = wallCreatedEventProperties({
      layoutId: 9001,
      board: row({ gymUuid: 'gym-1' }),
      meta: meta(),
      pendingVisibility: { isPublic: true, isUnlisted: false },
    });

    expect(properties).toEqual({
      boardType: 'spray',
      layoutId: 9001,
      // A wall's size id IS its layout id — it has exactly one size, itself.
      sizeId: 9001,
      setCount: 1,
      angle: 25,
      isOwned: true,
      // The END state: created private, made public by the `updateSprayWall`
      // that runs in this same publish.
      isPublic: true,
      hasLocationName: true,
      hasCoords: true,
      hasGym: true,
      gymUuid: 'gym-1',
      source: 'spray_wizard',
      resumed: false,
    });
  });

  // The regression this module exists for. A resumed run rejoins at the photo or
  // the editor and never runs the meta step, so the builder still holds its
  // constructor defaults — 40 degrees, no gym, private. Reading those would
  // report a 25-degree wall attached to a gym as an unattached 40-degree one.
  it('reports a RESUMED wall from the row, never from a builder that never ran', () => {
    const properties = wallCreatedEventProperties({
      layoutId: 9002,
      board: row({ angle: 55, isPublic: false, gymUuid: 'gym-7' }),
      meta: null,
      pendingVisibility: null,
    });

    expect(properties.angle).toBe(55);
    expect(properties.hasGym).toBe(true);
    expect(properties.gymUuid).toBe('gym-7');
    expect(properties.isPublic).toBe(false);
    expect(properties.resumed).toBe(true);
  });

  it('omits the two location properties on a resumed wall rather than sending false', () => {
    const properties = wallCreatedEventProperties({
      layoutId: 9003,
      board: row(),
      meta: null,
      pendingVisibility: null,
    });

    // Absent, not false: the row cannot answer for them, and a confident `false`
    // would be indistinguishable from a real "no location" in the funnel.
    expect('hasLocationName' in properties).toBe(false);
    expect('hasCoords' in properties).toBe(false);
  });

  it('prefers the row over the meta step when they disagree', () => {
    // They only disagree when the row is the later truth — a wall whose angle was
    // edited between sittings. The row is what the climber actually has.
    const properties = wallCreatedEventProperties({
      layoutId: 9004,
      board: row({ angle: 70 }),
      meta: meta({ angle: 25 }),
      pendingVisibility: null,
    });

    expect(properties.angle).toBe(70);
  });

  it('falls back to the meta step when the board payload never arrived', () => {
    const properties = wallCreatedEventProperties({
      layoutId: 9005,
      board: null,
      meta: meta({ angle: 35, gymUuid: null }),
      pendingVisibility: null,
    });

    expect(properties.angle).toBe(35);
    expect(properties.hasGym).toBe(false);
    expect('gymUuid' in properties).toBe(false);
    expect(properties.resumed).toBe(false);
  });

  it('reports the visibility about to be written, not the private row it is replacing', () => {
    // Every wall is created private, so the row says false right up until the
    // `updateSprayWall` that runs beside this event.
    const unlisted = wallCreatedEventProperties({
      layoutId: 9006,
      board: row({ isPublic: false }),
      meta: meta(),
      pendingVisibility: { isPublic: false, isUnlisted: true },
    });
    expect(unlisted.isPublic).toBe(false);

    const kept = wallCreatedEventProperties({
      layoutId: 9007,
      board: row({ isPublic: false }),
      meta: meta(),
      pendingVisibility: null,
    });
    expect(kept.isPublic).toBe(false);
  });
});
