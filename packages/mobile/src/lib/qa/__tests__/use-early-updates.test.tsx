// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({
  earlyUpdates: false,
  surfingBuild: true,
  flag: 'on' as 'on' | 'off' | 'unknown',
}));
vi.mock('../../../settings/hooks', () => ({
  useSetting: (key: string) => [key === 'earlyUpdates' ? state.earlyUpdates : null, vi.fn()],
}));
vi.mock('../../ota-branch-surfing-state', () => ({
  useOtaBranchSurfingState: () => ({ surfingBuild: state.surfingBuild, ready: true }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useEarlyUpdatesFlagState: () => state.flag,
}));

const listQaBranches = vi.hoisted(() => vi.fn());
vi.mock('../qa-surf', () => ({ listQaBranches }));

import { useEarlyUpdates, useEarlyUpdatesMember } from '../use-early-updates';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const NO_PREVIEWS = { previews: [], staging: null };

beforeEach(() => {
  state.earlyUpdates = false;
  state.surfingBuild = true;
  state.flag = 'on';
  listQaBranches.mockReset().mockResolvedValue({ ...NO_PREVIEWS, earlyUpdates: null });
});

describe('useEarlyUpdates', () => {
  it.each(['off', 'unknown'] as const)('hides the switch while the flag is %s', (flag) => {
    // Ships dark: unresolved and off both read as hidden.
    state.flag = flag;
    state.earlyUpdates = true;
    const { result } = renderHook(() => useEarlyUpdates(), { wrapper });

    expect(result.current).toMatchObject({ show: false, member: false });
    expect(listQaBranches).not.toHaveBeenCalled();
  });

  it('hides the switch on a build that cannot surf', () => {
    state.surfingBuild = false;
    state.earlyUpdates = true;
    const { result } = renderHook(() => useEarlyUpdates(), { wrapper });

    expect(result.current).toMatchObject({ show: false, member: false });
  });

  it('offers the switch, off, without asking the update server', () => {
    const { result } = renderHook(() => useEarlyUpdates(), { wrapper });

    expect(result.current).toEqual({ show: true, member: false, availability: 'unknown', lastUpdateAt: null });
    expect(listQaBranches).not.toHaveBeenCalled();
  });

  it('a member the server has an early update for', async () => {
    state.earlyUpdates = true;
    listQaBranches.mockResolvedValue({ ...NO_PREVIEWS, earlyUpdates: { lastUpdateAt: '2026-10-05T09:00:00.000Z' } });
    const { result } = renderHook(() => useEarlyUpdates(), { wrapper });

    await waitFor(() => expect(result.current.availability).toBe('offered'));
    expect(result.current).toMatchObject({ member: true, lastUpdateAt: '2026-10-05T09:00:00.000Z' });
  });

  it('a member the server has nothing for yet is waiting', async () => {
    state.earlyUpdates = true;
    const { result } = renderHook(() => useEarlyUpdates(), { wrapper });

    await waitFor(() => expect(result.current.availability).toBe('waiting'));
    expect(result.current.lastUpdateAt).toBeNull();
  });

  it('claims nothing while the update server cannot be reached', async () => {
    state.earlyUpdates = true;
    listQaBranches.mockRejectedValue(new Error('Could not reach the update server (502).'));
    const { result } = renderHook(() => useEarlyUpdates(), { wrapper });

    await waitFor(() => expect(listQaBranches).toHaveBeenCalled());
    expect(result.current).toMatchObject({ member: true, availability: 'unknown' });
  });

  it('claims nothing when the server has no list for this channel', async () => {
    // Surfing-off also flips the stored choice inside listQaBranches; a 404
    // from elsewhere does not. Neither is "waiting for the next update".
    state.earlyUpdates = true;
    listQaBranches.mockResolvedValue(null);
    const { result } = renderHook(() => useEarlyUpdates(), { wrapper });

    await waitFor(() => expect(listQaBranches).toHaveBeenCalled());
    expect(result.current.availability).toBe('unknown');
  });
});

describe('useEarlyUpdatesMember', () => {
  it('is the stored choice AND the flag', () => {
    state.earlyUpdates = true;
    expect(renderHook(() => useEarlyUpdatesMember()).result.current).toBe(true);

    state.flag = 'off';
    expect(renderHook(() => useEarlyUpdatesMember()).result.current).toBe(false);

    state.flag = 'on';
    state.earlyUpdates = false;
    expect(renderHook(() => useEarlyUpdatesMember()).result.current).toBe(false);
  });
});
