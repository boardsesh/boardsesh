import { describe, expect, it } from 'vitest';
import { ReportBoardLayersInputSchema } from '../board-presence';

describe('ReportBoardLayersInputSchema', () => {
  const layer = {
    color: '#1a2b3c',
    remainingSeconds: 60,
    climbUuid: null,
    angle: null,
    geometryKnown: false,
  };

  it('accepts foreign colours and duplicate colours from controller readback', () => {
    const parsed = ReportBoardLayersInputSchema.parse([layer, layer]);
    expect(parsed.map(({ color }) => color)).toEqual(['#1A2B3C', '#1A2B3C']);
  });

  it.each(['1A2B3C', '#12345', '#GG0000'])('rejects a malformed controller colour: %s', (color) => {
    expect(ReportBoardLayersInputSchema.safeParse([{ ...layer, color }]).success).toBe(false);
  });
});
