import { describe, expect, it } from 'vitest';
import { SaveClimbInputSchema, UpdateClimbInputSchema, parseQuantumClimbPlacementIds } from '../climbs';

const validSave = {
  boardType: 'quantum',
  layoutId: 9101,
  name: 'Quantum climb',
  isDraft: true,
  frames: 'p1000001r12p1000002r13p1000003r14',
  angle: 40,
};

describe('Quantum climb mutation validation', () => {
  it('accepts one strict frame on a known Quantum layout', () => {
    expect(SaveClimbInputSchema.safeParse(validSave).success).toBe(true);
    expect(parseQuantumClimbPlacementIds(validSave.frames)).toEqual([1000001, 1000002, 1000003]);
  });

  it.each([
    { input: { ...validSave, layoutId: 1 }, reason: 'layout' },
    {
      input: { ...validSave, frames: 'p1000001r12,p1000002r14', framesCount: 2 },
      reason: 'multiple frames',
    },
    { input: { ...validSave, frames: 'p1000001r15' }, reason: 'invalid role' },
    { input: { ...validSave, frames: 'p1000001r12p1000001r14' }, reason: 'duplicate hold' },
    { input: { ...validSave, frames: 'junkp1000001r12' }, reason: 'partial match' },
  ])('rejects invalid Quantum save geometry: $reason', ({ input }) => {
    expect(SaveClimbInputSchema.safeParse(input).success).toBe(false);
  });

  it('rejects invalid Quantum frames and frame counts on update', () => {
    expect(
      UpdateClimbInputSchema.safeParse({
        uuid: 'climb-1',
        boardType: 'quantum',
        frames: 'p1000001r12,p1000002r14',
      }).success,
    ).toBe(false);
    expect(UpdateClimbInputSchema.safeParse({ uuid: 'climb-1', boardType: 'quantum', framesCount: 2 }).success).toBe(
      false,
    );
  });

  it.each(['p999999r12', 'p6000000r13', 'p2147483648r14'])(
    'rejects out-of-domain placement IDs before save and update: %s',
    (frames) => {
      expect(parseQuantumClimbPlacementIds(frames)).toBeNull();
      expect(SaveClimbInputSchema.safeParse({ ...validSave, frames }).success).toBe(false);
      expect(UpdateClimbInputSchema.safeParse({ uuid: 'climb-1', boardType: 'quantum', frames }).success).toBe(false);
    },
  );

  it('accepts both canonical placement-domain boundaries', () => {
    expect(parseQuantumClimbPlacementIds('p1000000r12p5999999r14')).toEqual([1_000_000, 5_999_999]);
  });

  it('enforces the controller diode limit', () => {
    const tooManyHolds = Array.from({ length: 93 }, (_, index) => `p${1_000_000 + index}r13`).join('');
    expect(SaveClimbInputSchema.safeParse({ ...validSave, frames: tooManyHolds }).success).toBe(false);
  });
});
