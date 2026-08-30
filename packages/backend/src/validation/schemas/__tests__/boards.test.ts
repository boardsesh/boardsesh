import { describe, expect, it } from 'vitest';
import { CreateBoardInputSchema, UpdateBoardInputSchema, boardAngleInputSchemaFor } from '../boards';

const BOARD_UUID = '11111111-1111-4111-8111-111111111111';

describe('board angle validation', () => {
  it('accepts signed QuantumBoard angles through 90 degrees', () => {
    expect(
      CreateBoardInputSchema.safeParse({
        boardType: 'quantum',
        layoutId: 9101,
        sizeId: 9201,
        setIds: '1',
        name: 'Quantum wall',
        angle: 90,
      }).success,
    ).toBe(true);
    expect(UpdateBoardInputSchema.safeParse({ boardUuid: BOARD_UUID, angle: 90 }).success).toBe(true);
    expect(boardAngleInputSchemaFor('quantum').safeParse(90).success).toBe(true);
  });

  it('retains the 70-degree cap for other board families', () => {
    expect(
      CreateBoardInputSchema.safeParse({
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Kilter wall',
        angle: 71,
      }).success,
    ).toBe(false);
    expect(boardAngleInputSchemaFor('kilter').safeParse(71).success).toBe(false);
  });

  it('rejects angles above the QuantumBoard catalog bound', () => {
    expect(
      CreateBoardInputSchema.safeParse({
        boardType: 'quantum',
        layoutId: 9101,
        sizeId: 9201,
        setIds: '1',
        name: 'Quantum wall',
        angle: 91,
      }).success,
    ).toBe(false);
    expect(UpdateBoardInputSchema.safeParse({ boardUuid: BOARD_UUID, angle: 91 }).success).toBe(false);
  });
});
