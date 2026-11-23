import { describe, expect, it } from 'vitest';
import { boardMergeConfigsCompatible } from '../board-merge-compatibility';

const kilter = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };
const tensionMirror = { boardType: 'tension', layoutId: 10, sizeId: 6, setIds: '12,13' };

describe('duplicate board merge eligibility', () => {
  it('allows different angles without changing either stored configuration', () => {
    const first = { ...kilter, angle: 20 };
    const second = { ...kilter, angle: 50 };
    expect(boardMergeConfigsCompatible(first, second)).toBe(true);
    expect(first.angle).toBe(20);
    expect(second.angle).toBe(50);
  });

  it('compares hold sets independently of their order and duplicates', () => {
    expect(boardMergeConfigsCompatible(kilter, { ...kilter, setIds: '2, 1,2' })).toBe(true);
  });

  it('allows TB2 Mirror and Spray in both directions', () => {
    const tensionSpray = { ...tensionMirror, layoutId: 11 };
    expect(boardMergeConfigsCompatible(tensionMirror, tensionSpray)).toBe(true);
    expect(boardMergeConfigsCompatible(tensionSpray, tensionMirror)).toBe(true);
  });

  it.each([
    { ...kilter, layoutId: 8 },
    { ...kilter, sizeId: 11 },
    { ...kilter, setIds: '1,2,3' },
    { ...kilter, boardType: 'tension' },
  ])('refuses an incompatible installation: %j', (otherBoard) => {
    expect(boardMergeConfigsCompatible(kilter, otherBoard)).toBe(false);
    expect(boardMergeConfigsCompatible(otherBoard, kilter)).toBe(false);
  });

  it('does not extend the TB2 exception to original Tension, size or hold sets', () => {
    expect(boardMergeConfigsCompatible(tensionMirror, { ...tensionMirror, layoutId: 9 })).toBe(false);
    expect(boardMergeConfigsCompatible(tensionMirror, { ...tensionMirror, layoutId: 11, sizeId: 7 })).toBe(false);
    expect(boardMergeConfigsCompatible(tensionMirror, { ...tensionMirror, layoutId: 11, setIds: '12' })).toBe(false);
  });

  it('excludes custom spray walls even when their config is identical', () => {
    const spray = { ...kilter, boardType: 'spray' };
    expect(boardMergeConfigsCompatible(spray, spray)).toBe(false);
  });
});
