import { describe, expect, it } from 'vitest';
import { buildWallGlowInput } from '../wall-glow-input';

const roleColors = new Map([
  ['STARTING', '#00FF00'],
  ['HAND', '#0099FF'],
]);
const source = {
  parsedHolds: [
    { id: 1, cx: 20, cy: 40, role: 'STARTING' as const, color: '#FFFFFF' },
    { id: 2, cx: 70, cy: 90, role: 'HAND' as const, color: '#FFFFFF' },
  ],
  roleColors,
  boardWidth: 100,
  boardHeight: 120,
  climbUuid: 'first-climb',
  frames: 'p1r12p2r13',
  mirrored: false,
};

describe('buildWallGlowInput', () => {
  it('uses the board role palette and keeps each parsed hold position', () => {
    expect(buildWallGlowInput(source)).toMatchObject({
      holds: [
        { x: 20, y: 40, color: '#00FF00' },
        { x: 70, y: 90, color: '#0099FF' },
      ],
      boardWidth: 100,
      boardHeight: 120,
    });
  });

  it('deduplicates holds shared by animation snapshots, retaining the first role', () => {
    expect(
      buildWallGlowInput({
        ...source,
        parsedHolds: [...source.parsedHolds, { id: 1, cx: 20, cy: 40, role: 'HAND', color: '#FFFFFF' }],
      })?.holds,
    ).toEqual([
      { x: 20, y: 40, color: '#00FF00' },
      { x: 70, y: 90, color: '#0099FF' },
    ]);
  });

  it('keeps a parsed fallback colour when its role has no palette entry', () => {
    expect(buildWallGlowInput({ ...source, roleColors: new Map() })?.holds[0]?.color).toBe('#FFFFFF');
  });

  it('changes the animation identity for a climb, frame, mirror or palette change', () => {
    const originalKey = buildWallGlowInput(source)?.key;
    expect(buildWallGlowInput({ ...source, climbUuid: 'second-climb' })?.key).not.toBe(originalKey);
    expect(buildWallGlowInput({ ...source, frames: 'p1r12' })?.key).not.toBe(originalKey);
    expect(buildWallGlowInput({ ...source, mirrored: true })?.key).not.toBe(originalKey);
    expect(buildWallGlowInput({ ...source, roleColors: new Map([['STARTING', '#123456']]) })?.key).not.toBe(
      originalKey,
    );
  });

  it('uses already mirrored positions without flipping them a second time', () => {
    expect(
      buildWallGlowInput({
        ...source,
        mirrored: true,
        parsedHolds: [{ ...source.parsedHolds[0]!, cx: 80 }],
      })?.holds,
    ).toEqual([{ x: 80, y: 40, color: '#00FF00' }]);
  });

  it('falls back without lit holds, frames or usable dimensions', () => {
    expect(buildWallGlowInput({ ...source, parsedHolds: [] })).toBeNull();
    expect(buildWallGlowInput({ ...source, frames: '' })).toBeNull();
    expect(buildWallGlowInput({ ...source, boardWidth: 0 })).toBeNull();
    expect(buildWallGlowInput({ ...source, boardHeight: Number.NaN })).toBeNull();
  });
});
