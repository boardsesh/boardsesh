// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const animation = vi.hoisted(() => ({
  reactions: [] as (() => void)[],
  commands: [] as number[][],
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    dispatchCommand: (_target: unknown, _name: string, args: readonly number[]) => animation.commands.push([...args]),
    useAnimatedReaction: <Prepared>(prepare: () => Prepared, react: (prepared: Prepared) => void) => {
      animation.reactions.push(() => react(prepare()));
    },
    useAnimatedRef: () => useRef({}).current,
    useSharedValue: <Value>(initial: Value) => useRef({ value: initial }).current,
  };
});

import type { SharedValue } from 'react-native-reanimated';
import type { BoardSwapFrame } from '../play-drawer/swap-look';
import { INITIAL_FROST_SWAP_FRAME, frostSwapFrame, useFrostSwapFrame } from '../use-frost-swap-frame';

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

describe('useFrostSwapFrame', () => {
  it('sends every frame as a command but writes the animated-prop copy only once, not per frame', () => {
    animation.commands = [];
    const frames = { value: [4, 1, 0, 1] as BoardSwapFrame | null };
    const { result } = renderHook(() =>
      useFrostSwapFrame(frames as unknown as SharedValue<BoardSwapFrame | null>, true),
    );
    const run = () => animation.reactions.at(-1)?.();
    run();
    frames.value = [4.25, 0.8, 0.1, 1, 0, 1];
    run();
    frames.value = null;
    run();
    expect(animation.commands).toEqual([[4, 1, 0, 1, 1], [4.25, 0.8, 0.1, 1, 2, 0, 1], [3]]);
    expect(result.current.latest.value).toEqual([4, 1, 0, 1, 1]);
  });

  it('sends nothing when disabled', () => {
    animation.commands = [];
    renderHook(() =>
      useFrostSwapFrame({ value: [4, 1, 0, 1] } as unknown as SharedValue<BoardSwapFrame | null>, false),
    );
    animation.reactions.at(-1)?.();
    expect(animation.commands).toEqual([]);
  });
});
