// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PlaylistsAdapter } from '@boardsesh/playlists-react';
import { BackendUnavailableError } from '../../lib/connectivity/backend-unavailable-error';

const mocks = vi.hoisted(() => ({
  executeGraphQL: vi.fn(),
  recents: { getRecentPlaylists: vi.fn(async () => []) },
}));

let capturedAdapter: PlaylistsAdapter | undefined;
vi.mock('@boardsesh/playlists-react', () => ({
  PlaylistsAdapterProvider: ({ value, children }: { value: PlaylistsAdapter; children: ReactNode }) => {
    capturedAdapter = value;
    return children;
  },
}));
vi.mock('../../lib/graphql/offline-request', () => ({ offlineAwareRequest: mocks.executeGraphQL }));
vi.mock('../../lib/playlists/recents-store', () => ({ mobileRecentsAdapter: mocks.recents }));

import { PlaylistsAdapterWrapper } from '../playlists-adapter';

beforeEach(() => {
  capturedAdapter = undefined;
  mocks.executeGraphQL.mockReset();
});

describe('PlaylistsAdapterWrapper', () => {
  it.each(['offline_mode', 'device_offline', 'backend_unreachable'] as const)(
    'classifies the %s request gate refusal as expected',
    (reason) => {
      render(<PlaylistsAdapterWrapper>Library</PlaylistsAdapterWrapper>);
      const error = new BackendUnavailableError(reason);

      expect(capturedAdapter?.isExpectedRequestError?.(error)).toBe(true);
      // Match across module instances, as the request gate's existing classifier does.
      expect(capturedAdapter?.isExpectedRequestError?.({ name: error.name, reason })).toBe(true);
    },
  );

  it('does not classify genuine request or storage failures as expected', () => {
    render(<PlaylistsAdapterWrapper>Library</PlaylistsAdapterWrapper>);

    expect(capturedAdapter?.isExpectedRequestError?.(new Error('Resolver failed'))).toBe(false);
    expect(capturedAdapter?.isExpectedRequestError?.(new Error('Storage unavailable'))).toBe(false);
    expect(capturedAdapter?.isExpectedRequestError?.(null)).toBe(false);
  });

  it('keeps its adapter and classifier stable across renders', () => {
    const { rerender } = render(<PlaylistsAdapterWrapper>Library</PlaylistsAdapterWrapper>);
    const previousAdapter = capturedAdapter;

    rerender(<PlaylistsAdapterWrapper>Updated library</PlaylistsAdapterWrapper>);

    expect(capturedAdapter).toBe(previousAdapter);
    expect(capturedAdapter?.isExpectedRequestError).toBe(previousAdapter?.isExpectedRequestError);
  });

  it('preserves the offline-aware transport and recents storage', async () => {
    mocks.executeGraphQL.mockResolvedValue({ myPinnedPlaylists: [] });
    render(<PlaylistsAdapterWrapper>Library</PlaylistsAdapterWrapper>);

    await expect(capturedAdapter?.executeGraphQL('query Pinned', { input: { boardType: 'kilter' } })).resolves.toEqual({
      myPinnedPlaylists: [],
    });
    expect(mocks.executeGraphQL).toHaveBeenCalledExactlyOnceWith('query Pinned', { input: { boardType: 'kilter' } });
    expect(capturedAdapter?.recents).toBe(mocks.recents);
  });
});
