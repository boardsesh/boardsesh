import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-reanimated', () => ({
  dispatchCommand: vi.fn(),
  useAnimatedReaction: vi.fn(),
  useAnimatedRef: vi.fn(),
  useSharedValue: vi.fn(),
}));

import { INITIAL_FROST_SWAP_FRAME, frostSwapFrame } from '../use-frost-swap-frame';

describe('frostSwapFrame', () => {
  it('puts the sequence after the fourth number, as the board overlay takes it', () => {
    expect(frostSwapFrame([4, 1, 0, 1], 3)).toEqual([4, 1, 0, 1, 3]);
    expect(frostSwapFrame([4.25, 0.6, 0.3, 1, 0, 1], 4)).toEqual([4.25, 0.6, 0.3, 1, 4, 0, 1]);
  });

  it('sends the sequence alone when the board draws no frames', () => {
    expect(frostSwapFrame(null, 9)).toEqual([9]);
    expect(INITIAL_FROST_SWAP_FRAME).toEqual([0]);
  });
});
