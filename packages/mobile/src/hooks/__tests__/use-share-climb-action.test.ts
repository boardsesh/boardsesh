// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

const effects = vi.hoisted(() => ({
  track: vi.fn(),
  showToast: vi.fn(),
  shareClimb: vi.fn<() => Promise<void>>(),
  shareArgs: null as unknown,
}));
vi.mock('../../lib/analytics', () => ({ track: effects.track }));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: effects.showToast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../use-share-climb', () => ({
  useShareClimb: (args: unknown) => {
    effects.shareArgs = args;
    return effects.shareClimb;
  },
}));

import { useShareClimbAction } from '../use-share-climb-action';

const climb = { uuid: 'climb-a', name: 'Climb A', frames: 'p1r12', angle: 40 } as Climb;
const target = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  effects.shareClimb.mockResolvedValue(undefined);
});

describe('useShareClimbAction', () => {
  it('shares this climb on its board and tracks the intent with its source', () => {
    const { result } = renderHook(() => useShareClimbAction({ climb, ...target, source: 'mini_player' }));
    expect(effects.shareArgs).toEqual({ climb, ...target });
    result.current();
    expect(effects.shareClimb).toHaveBeenCalledOnce();
    expect(effects.track).toHaveBeenCalledWith('Climb Shared', {
      method: 'share',
      source: 'mini_player',
      climbUuid: 'climb-a',
      boardName: 'kilter',
      layoutId: 1,
    });
  });

  it('says so when the share sheet throws', async () => {
    effects.shareClimb.mockRejectedValue(new Error('cancelled'));
    const { result } = renderHook(() => useShareClimbAction({ climb, ...target, source: 'play_drawer' }));
    result.current();
    await waitFor(() => expect(effects.showToast).toHaveBeenCalledWith('playView.shareError', 'error'));
  });

  it('does nothing without a climb', () => {
    const { result } = renderHook(() => useShareClimbAction({ climb: null, ...target, source: 'play_drawer' }));
    result.current();
    expect(effects.shareClimb).not.toHaveBeenCalled();
    expect(effects.track).not.toHaveBeenCalled();
  });
});
