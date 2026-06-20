import { describe, it, expect } from 'vitest';
import { parseInstagramBetaCaption } from '../instagram-caption-parse';

describe('parseInstagramBetaCaption', () => {
  it('parses the canonical Kilter share caption', () => {
    const caption =
      '"Air Bender" @ 40° on the Kilter Board.\n@kilterboard #kilterboard #kiltergrips @boardsesh #boardsesh';
    expect(parseInstagramBetaCaption(caption)).toEqual({ climbName: 'Air Bender', angle: 40, boardType: 'kilter' });
  });

  it('parses the Tension share caption', () => {
    const caption = '"Crimp Master" @ 25° on the Tension Board. @tensionclimbing #tensionboard #climbing';
    expect(parseInstagramBetaCaption(caption)).toEqual({ climbName: 'Crimp Master', angle: 25, boardType: 'tension' });
  });

  it('tolerates a missing degree sign', () => {
    expect(parseInstagramBetaCaption('"Sloper City" @ 30 on the Kilter Board')).toEqual({
      climbName: 'Sloper City',
      angle: 30,
      boardType: 'kilter',
    });
  });

  it('handles curly and guillemet quotes', () => {
    expect(parseInstagramBetaCaption('“Big Fish” @ 45° on the Kilter Board')).toEqual({
      climbName: 'Big Fish',
      angle: 45,
      boardType: 'kilter',
    });
    expect(parseInstagramBetaCaption('«Le Toit» @ 50° on the Kilter Board')).toEqual({
      climbName: 'Le Toit',
      angle: 50,
      boardType: 'kilter',
    });
  });

  it('returns a null angle when none is present', () => {
    expect(parseInstagramBetaCaption('"Mystery Climb" on the Kilter Board')).toEqual({
      climbName: 'Mystery Climb',
      angle: null,
      boardType: 'kilter',
    });
  });

  it('returns a null board when it cannot be inferred', () => {
    expect(parseInstagramBetaCaption('"Just A Climb" @ 40°')).toEqual({
      climbName: 'Just A Climb',
      angle: 40,
      boardType: null,
    });
  });

  it('does not mistake a social handle for an angle', () => {
    expect(parseInstagramBetaCaption('check out @kilterboard — "Send It" @ 50°')).toEqual({
      climbName: 'Send It',
      angle: 50,
      boardType: 'kilter',
    });
  });

  it('skips a leading-digit handle before the angle', () => {
    expect(parseInstagramBetaCaption('beta by @123climber "Send It" @ 40° on the Kilter Board')).toEqual({
      climbName: 'Send It',
      angle: 40,
      boardType: 'kilter',
    });
  });

  it('rejects an out-of-range angle but keeps the name', () => {
    expect(parseInstagramBetaCaption('"Weird Angle" @ 99°')).toEqual({
      climbName: 'Weird Angle',
      angle: null,
      boardType: null,
    });
  });

  it('returns null for non-beta captions', () => {
    expect(parseInstagramBetaCaption('Great session today 💪 so pumped')).toBeNull();
    expect(parseInstagramBetaCaption('')).toBeNull();
    expect(parseInstagramBetaCaption(null)).toBeNull();
    expect(parseInstagramBetaCaption(undefined)).toBeNull();
  });

  it('takes the first quoted name when several are present', () => {
    expect(parseInstagramBetaCaption('"Project" @ 40° — felt like "Easy" tbh, on the Kilter Board')).toEqual({
      climbName: 'Project',
      angle: 40,
      boardType: 'kilter',
    });
  });
});
