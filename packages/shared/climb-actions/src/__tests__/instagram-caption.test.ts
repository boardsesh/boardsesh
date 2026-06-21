import { describe, it, expect } from 'vitest';
import { buildInstagramCaption, getBoardDisplayName } from '../instagram-caption';

describe('buildInstagramCaption', () => {
  it('builds the Kilter caption when boardType is omitted', () => {
    expect(buildInstagramCaption({ climbName: 'Texas Sun', angle: 35 })).toBe(
      `"Texas Sun" @ 35° on the Kilter Board.\n@kilterboard #kilterboard #kiltergrips @boardsesh #boardsesh`,
    );
  });

  it('builds the Tension caption with a space separator', () => {
    expect(buildInstagramCaption({ climbName: 'High Hopes', angle: 40, boardType: 'tension' })).toBe(
      `"High Hopes" @ 40° on the Tension Board. @tensionclimbing #tensionboard #climbing #bouldering @boardsesh #boardsesh`,
    );
  });

  it('builds the full MoonBoard caption with grade, layout, and setter', () => {
    expect(
      buildInstagramCaption({
        climbName: 'Wheel of Fortune',
        angle: 40,
        boardType: 'moonboard',
        grade: 'V7',
        setter: 'Dana Rader',
        layoutId: 3,
      }),
    ).toBe(
      `Wheel of Fortune, V7, 40° MoonBoard, MoonBoard 2024 setup, set by Dana Rader. - @moonclimbing #moonboard #moonclimbing #moonboardchallenge #trainhardclimbharder @boardsesh #boardsesh`,
    );
  });

  it('falls back to the Kilter caption for an unknown boardType', () => {
    expect(buildInstagramCaption({ climbName: 'Mystery Route', angle: 50, boardType: 'unknownboard' })).toBe(
      `"Mystery Route" @ 50° on the Kilter Board.\n@kilterboard #kilterboard #kiltergrips @boardsesh #boardsesh`,
    );
  });

  // The share-back flow recovers the climb from the reel caption by matching the
  // climb name (matchClimbsToCaption), so every caption MUST contain it verbatim.
  it('always embeds the climb name so share-back auto-match can recover the climb', () => {
    for (const boardType of ['kilter', 'tension', 'moonboard', 'unknownboard']) {
      expect(buildInstagramCaption({ climbName: 'Purple Nurple', angle: 40, boardType })).toContain('Purple Nurple');
    }
  });
});

describe('getBoardDisplayName', () => {
  it('returns the short display name for known boards', () => {
    expect(getBoardDisplayName('kilter')).toBe('Kilter');
    expect(getBoardDisplayName('moonboard')).toBe('MoonBoard');
  });

  it('capitalises an unknown boardType', () => {
    expect(getBoardDisplayName('futureboard')).toBe('Futureboard');
  });
});
