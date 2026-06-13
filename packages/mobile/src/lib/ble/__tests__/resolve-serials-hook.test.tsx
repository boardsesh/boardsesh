// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { GET_BOARDS_BY_SERIAL_NUMBERS } from '@boardsesh/graphql/operations';

// The pure resolveBleSerialNumbers / serialsFromDiscoveredDevices suite stays in
// the node environment (resolve-serials.test.ts); only the React-Query hook
// needs jsdom, so it lives here to keep the environment switch off the rest.

const harness = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('../../auth-store', () => ({
  getAuthToken: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../graphql/client', () => ({
  getHttpClient: () => ({ request: harness.request }),
}));

vi.mock('../../graphql/use-auth-token', () => ({
  useAuthToken: vi.fn(() => ({ data: null })),
}));

import { useAuthToken } from '../../graphql/use-auth-token';
import { useResolvedBleDeviceBoards } from '../resolve-serials';

function makeBoard(serialNumber: string, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    id: 1,
    uuid: `board-${serialNumber}`,
    slug: `board-${serialNumber}`,
    ownerId: 'owner-1',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    name: `Board ${serialNumber}`,
    isPublic: false,
    isUnlisted: false,
    hideLocation: false,
    isOwned: true,
    angle: 40,
    isAngleAdjustable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    serialNumber,
    ...overrides,
  };
}

function makeDevices(serials: string[]) {
  return serials.map((serial, index) => ({
    deviceId: `device-${index}`,
    name: `Kilter Board#${serial}@3`,
    rssi: -50,
  }));
}

function QueryWrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useResolvedBleDeviceBoards', () => {
  beforeEach(() => {
    harness.request.mockReset();
    vi.mocked(useAuthToken).mockReturnValue({ data: undefined } as ReturnType<typeof useAuthToken>);
  });

  it('fires the saved-boards query when signed out (authToken === null) because null !== undefined', async () => {
    // The enabled guard is `authToken !== undefined`, so null (signed-out) lets
    // the query through — only the recorded-configs branch requires a token.
    vi.mocked(useAuthToken).mockReturnValue({ data: null } as ReturnType<typeof useAuthToken>);
    harness.request.mockImplementation((operation: unknown) => {
      if (operation === GET_BOARDS_BY_SERIAL_NUMBERS) {
        return Promise.resolve({ boardsBySerialNumbers: [makeBoard('SN-A')] });
      }
      return Promise.reject(new Error('Unexpected operation'));
    });

    const { result } = renderHook(() => useResolvedBleDeviceBoards(makeDevices(['SN-A'])), {
      wrapper: QueryWrapper,
    });

    await waitFor(() => expect(result.current.size).toBeGreaterThan(0));

    expect(result.current.get('SN-A')).toEqual({ kind: 'saved', board: makeBoard('SN-A') });
    // Only the public saved-boards query fires; the auth-gated recorded-configs
    // query is skipped because authToken is null (falsy) inside resolveBleSerialNumbers.
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenCalledWith(GET_BOARDS_BY_SERIAL_NUMBERS, { serialNumbers: ['SN-A'] });
  });

  it('does not fire any query while authToken is still loading (authToken === undefined)', async () => {
    // useAuthToken returns { data: undefined } while the token query is pending.
    // The enabled guard `authToken !== undefined` evaluates to false, so the
    // hook should return the empty map without making any requests.
    vi.mocked(useAuthToken).mockReturnValue({ data: undefined } as ReturnType<typeof useAuthToken>);

    const { result } = renderHook(() => useResolvedBleDeviceBoards(makeDevices(['SN-B'])), {
      wrapper: QueryWrapper,
    });

    // Give TanStack Query a tick to evaluate the enabled guard.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.request).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });
});
