// @vitest-environment jsdom
// The one handler behind the busy-wall question (#7017): taps on either
// segment count only 500 ms after the question appears, and VoiceOver hears
// the caption once.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announceForAccessibility = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({ AccessibilityInfo: { announceForAccessibility } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      [key, params?.person, params?.name].filter((part) => part != null).join(':'),
  }),
}));

import { BUSY_WALL_TAP_DEBOUNCE_MS } from '../busy-wall-question';
import { useBusyWallQuestion, type UseBusyWallQuestionOptions } from '../use-busy-wall-question';

type Props = Pick<UseBusyWallQuestionOptions, 'armed' | 'holder'>;

function setup(initial: Props) {
  const onKeep = vi.fn();
  const onPut = vi.fn();
  const hook = renderHook(
    (props: Props) =>
      useBusyWallQuestion({ ...props, wallClimbName: 'Crimp Ladder', selfHoldsBoard: true, onKeep, onPut }),
    { initialProps: initial },
  );
  return { hook, onKeep, onPut };
}

const TEST2 = { name: 'Test2', avatarUrl: null };

describe('useBusyWallQuestion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    announceForAccessibility.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has no model while no question is up, and passes taps straight through: the plain commit', () => {
    const { hook, onKeep, onPut } = setup({ armed: false, holder: null });
    expect(hook.result.current.model).toBeNull();
    act(() => {
      hook.result.current.keep();
      hook.result.current.put();
    });
    expect(onKeep).toHaveBeenCalledOnce();
    expect(onPut).toHaveBeenCalledOnce();
    expect(announceForAccessibility).not.toHaveBeenCalled();
  });

  it('drops taps on either segment for 500 ms after the question appears', () => {
    const { hook, onKeep, onPut } = setup({ armed: true, holder: TEST2 });
    expect(hook.result.current.model?.ready).toBe(false);
    act(() => {
      vi.advanceTimersByTime(BUSY_WALL_TAP_DEBOUNCE_MS - 1);
      hook.result.current.put();
      hook.result.current.keep();
    });
    expect(onPut).not.toHaveBeenCalled();
    expect(onKeep).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(hook.result.current.model?.ready).toBe(true);
    act(() => hook.result.current.put());
    expect(onPut).toHaveBeenCalledOnce();
    act(() => hook.result.current.keep());
    expect(onKeep).toHaveBeenCalledOnce();
  });

  it('starts the debounce over when the question comes back', () => {
    const { hook, onPut } = setup({ armed: true, holder: TEST2 });
    act(() => {
      vi.advanceTimersByTime(BUSY_WALL_TAP_DEBOUNCE_MS);
    });
    hook.rerender({ armed: false, holder: TEST2 });
    hook.rerender({ armed: true, holder: TEST2 });
    expect(hook.result.current.model?.ready).toBe(false);
    act(() => hook.result.current.put());
    expect(onPut).not.toHaveBeenCalled();
  });

  it('keeps its handlers across renders, so a memoised bar doesn’t re-render for them', () => {
    const { hook } = setup({ armed: true, holder: TEST2 });
    const { keep, put } = hook.result.current;
    act(() => {
      vi.advanceTimersByTime(BUSY_WALL_TAP_DEBOUNCE_MS);
    });
    expect(hook.result.current.keep).toBe(keep);
    expect(hook.result.current.put).toBe(put);
  });

  it('says the caption once when the question appears, not again when the name resolves', () => {
    const { hook } = setup({ armed: true, holder: TEST2 });
    expect(announceForAccessibility).toHaveBeenCalledOnce();
    expect(announceForAccessibility).toHaveBeenCalledWith(
      'playView.wallState.busyWall.captionNamed:Test2:Crimp Ladder',
    );
    hook.rerender({ armed: true, holder: { name: 'Sam', avatarUrl: null } });
    expect(announceForAccessibility).toHaveBeenCalledOnce();
    expect(hook.result.current.model?.holderName).toBe('Sam');
  });
});
