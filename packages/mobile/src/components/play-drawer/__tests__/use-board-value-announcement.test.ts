// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const announceQueued = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/announce-queued', () => ({ announceQueued }));

import { useBoardValueAnnouncement } from '../use-board-value-announcement';

type Props = Parameters<typeof useBoardValueAnnouncement>[0];

const onLow: Props = {
  displayedClimbUuid: 'low',
  nextClimbUuid: 'yoshi',
  previousClimbUuid: 'tour-guide',
  value: 'Low, V4, 4 of 40',
};
const onYoshi: Props = {
  displayedClimbUuid: 'yoshi',
  nextClimbUuid: 'tour-guide',
  previousClimbUuid: 'low',
  value: 'Yoshi’s Island, V5, 5 of 40',
};

beforeEach(() => announceQueued.mockClear());

describe('useBoardValueAnnouncement', () => {
  it('announces the climb a step landed on, once, with its value', () => {
    const { result, rerender } = renderHook((props: Props) => useBoardValueAnnouncement(props), {
      initialProps: onLow,
    });
    act(() => result.current('next'));
    expect(announceQueued).not.toHaveBeenCalled();

    rerender(onYoshi);
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('Yoshi’s Island, V5, 5 of 40');

    rerender({ ...onYoshi, value: 'Yoshi’s Island, V5+, 5 of 40' });
    expect(announceQueued).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the climb changes without a step of the climber’s', () => {
    const { rerender } = renderHook((props: Props) => useBoardValueAnnouncement(props), { initialProps: onLow });
    rerender(onYoshi);
    expect(announceQueued).not.toHaveBeenCalled();
  });

  it('drops a step that landed somewhere else', () => {
    const { result, rerender } = renderHook((props: Props) => useBoardValueAnnouncement(props), {
      initialProps: onLow,
    });
    act(() => result.current('next'));
    // A crewmate put another climb up first.
    rerender({ ...onYoshi, displayedClimbUuid: 'crimp-ladder', value: 'Crimp Ladder, V3' });
    rerender(onYoshi);
    expect(announceQueued).not.toHaveBeenCalled();
  });

  it('says nothing for a step with nowhere to go', () => {
    const atTheEnd: Props = { ...onLow, nextClimbUuid: null };
    const { result, rerender } = renderHook((props: Props) => useBoardValueAnnouncement(props), {
      initialProps: atTheEnd,
    });
    act(() => result.current('next'));
    rerender(onYoshi);
    expect(announceQueued).not.toHaveBeenCalled();
  });
});
