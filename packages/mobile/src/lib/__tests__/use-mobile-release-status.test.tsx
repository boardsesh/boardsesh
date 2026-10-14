// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseContext } from '@boardsesh/shared-schema';
import { MOBILE_RELEASE_STATUS } from '@boardsesh/graphql/operations';

const launch = vi.hoisted(() => ({
  enabled: true,
  platform: 'ios',
  embedded: false,
  updateId: 'running-update',
  branch: 'production',
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return launch.platform;
    },
  },
}));
vi.mock('expo-updates', () => ({
  get isEnabled() {
    return launch.enabled;
  },
}));
vi.mock('../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../release-context', () => ({
  readMobileReleaseContext: () => ({
    channel: 'production',
    branch: launch.branch,
    updateId: launch.updateId,
    runtimeVersion: 'runtime-1',
    isEmbeddedLaunch: launch.embedded,
  }),
}));

import { useMobileReleaseStatus } from '../use-mobile-release-status';

const verifiedRelease: ReleaseContext = {
  channel: 'production',
  branch: 'production',
  updateId: 'running-update',
  runtimeVersion: 'runtime-1',
  isEmbeddedLaunch: false,
  automaticCanary: true,
  canaryCheckedAt: '2026-10-14T02:00:00.000Z',
};

function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  Object.assign(launch, {
    enabled: true,
    platform: 'ios',
    embedded: false,
    updateId: 'running-update',
    branch: 'production',
  });
  request.mockReset().mockResolvedValue({ mobileReleaseStatus: verifiedRelease });
});

describe('useMobileReleaseStatus', () => {
  it('asks the backend about the running bundle and returns verified membership', async () => {
    const { wrapper, queryClient } = harness();
    const { result, unmount } = renderHook(useMobileReleaseStatus, { wrapper });
    await waitFor(() => expect(result.current.releaseContext).toEqual(verifiedRelease));
    expect(request).toHaveBeenCalledWith({
      document: MOBILE_RELEASE_STATUS,
      variables: {
        input: {
          channel: 'production',
          branch: 'production',
          updateId: 'running-update',
          runtimeVersion: 'runtime-1',
          isEmbeddedLaunch: false,
          platform: 'ios',
        },
      },
      signal: expect.any(AbortSignal),
    });
    expect(result.current.isPending).toBe(false);
    unmount();
    queryClient.clear();
  });

  it.each(['disabled', 'embedded', 'web'] as const)('does not fetch for %s launches', (kind) => {
    if (kind === 'disabled') launch.enabled = false;
    if (kind === 'embedded') launch.embedded = true;
    if (kind === 'web') launch.platform = 'web';
    const { wrapper, queryClient } = harness();
    const { result, unmount } = renderHook(useMobileReleaseStatus, { wrapper });
    expect(request).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(false);
    if (kind === 'disabled') expect(result.current.releaseContext).toBeNull();
    else expect(result.current.releaseContext?.automaticCanary).toBe(false);
    unmount();
    queryClient.clear();
  });

  it('leaves canary membership unknown when status lookup fails', async () => {
    request.mockRejectedValue(new Error('Offline'));
    const { wrapper, queryClient } = harness();
    const { result, unmount } = renderHook(useMobileReleaseStatus, { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.releaseContext).toEqual({
      ...verifiedRelease,
      automaticCanary: null,
      canaryCheckedAt: null,
    });
    unmount();
    queryClient.clear();
  });

  it('shares cached membership and preserves its timestamp when refresh fails', async () => {
    const { wrapper, queryClient } = harness();
    const { result, unmount } = renderHook(() => [useMobileReleaseStatus(), useMobileReleaseStatus()], { wrapper });
    await waitFor(() => expect(result.current[0].releaseContext?.automaticCanary).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValue(new Error('Offline'));
    await act(() => queryClient.invalidateQueries({ queryKey: ['mobileReleaseStatus'] }));
    expect(result.current[0].releaseContext).toEqual(verifiedRelease);
    expect(result.current[1].releaseContext).toEqual(verifiedRelease);
    unmount();
    queryClient.clear();
  });

  it('does not reuse one update’s membership for another update', async () => {
    const { wrapper, queryClient } = harness();
    const { result, rerender, unmount } = renderHook(useMobileReleaseStatus, { wrapper });
    await waitFor(() => expect(result.current.releaseContext?.automaticCanary).toBe(true));
    request.mockRejectedValue(new Error('Offline'));
    launch.updateId = 'different-running-update';
    rerender();
    expect(result.current.releaseContext?.automaticCanary).toBeNull();
    expect(result.current.releaseContext?.updateId).toBe('different-running-update');
    await waitFor(() => expect(result.current.isPending).toBe(false));
    unmount();
    queryClient.clear();
  });
});
