import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExecuteHttp } from '../adapter';
import { useLogbook } from '../use-logbook';
import { createWrapper } from './test-helpers';

describe('useLogbook local access', () => {
  it('reads SQLite after a signed-in Work Offline cold relaunch and never HTTP', async () => {
    const executeHttp = vi.fn();
    const getTicksLocal = vi.fn().mockResolvedValue([
      {
        uuid: 'queued-account-tick',
        climbUuid: 'climb-1',
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 1,
        quality: null,
        difficulty: null,
        isBenchmark: false,
        comment: '',
        climbedAt: '2026-08-30T00:00:00.000Z',
      },
    ]);
    const { wrapper } = createWrapper({
      isAuthenticated: true,
      canLogLocally: false,
      useLocalTickStore: true,
      executeHttp: executeHttp as unknown as ExecuteHttp,
      getTicksLocal,
    });

    const { result } = renderHook(() => useLogbook('kilter', ['climb-1']), { wrapper });
    await act(async () => {
      await waitFor(() => expect(result.current.logbook).toHaveLength(1));
    });

    expect(getTicksLocal).toHaveBeenCalledWith('kilter', ['climb-1']);
    expect(executeHttp).not.toHaveBeenCalled();
  });

  it('reads SQLite and never HTTP when a signed-in user selected local mode', async () => {
    const executeHttp = vi.fn();
    const getTicksLocal = vi.fn().mockResolvedValue([
      {
        uuid: 'local-tick',
        climbUuid: 'climb-1',
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 2,
        quality: null,
        difficulty: null,
        isBenchmark: false,
        comment: '',
        climbedAt: '2026-08-30T00:00:00.000Z',
      },
    ]);
    const { wrapper } = createWrapper({
      isAuthenticated: true,
      canLogLocally: true,
      executeHttp: executeHttp as unknown as ExecuteHttp,
      getTicksLocal,
    });

    const { result } = renderHook(() => useLogbook('kilter', ['climb-1']), { wrapper });
    await act(async () => {
      await waitFor(() => expect(result.current.logbook).toHaveLength(1));
    });

    expect(getTicksLocal).toHaveBeenCalledWith('kilter', ['climb-1']);
    expect(executeHttp).not.toHaveBeenCalled();
  });
});
