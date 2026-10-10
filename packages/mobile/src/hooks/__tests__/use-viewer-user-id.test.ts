// @vitest-environment jsdom
//
// Whose wall is this: the id an ownership check compares against `ownerId`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const session = vi.hoisted(() => ({
  isAuthenticated: true,
  profileId: null as string | null,
  storedUserId: undefined as string | undefined,
}));
const useProfileMock = vi.hoisted(() => vi.fn());
const useStoredUserIdMock = vi.hoisted(() => vi.fn());

vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: session.isAuthenticated }),
}));
vi.mock('../../lib/graphql/hooks', () => ({ useProfile: useProfileMock }));
vi.mock('../use-current-user-id', () => ({ useStoredUserId: useStoredUserIdMock }));

import { useViewerUserId } from '../use-viewer-user-id';

beforeEach(() => {
  session.isAuthenticated = true;
  session.profileId = null;
  session.storedUserId = undefined;
  useProfileMock.mockReset();
  useProfileMock.mockImplementation(() => ({ data: session.profileId ? { id: session.profileId } : undefined }));
  useStoredUserIdMock.mockReset();
  useStoredUserIdMock.mockImplementation(() => ({ userId: session.storedUserId, isLoading: false }));
});

describe('useViewerUserId', () => {
  it("answers with the profile's id once it has loaded, without reading the device", () => {
    session.profileId = 'profile-id';
    session.storedUserId = 'stored-id';
    const { result } = renderHook(() => useViewerUserId());
    expect(result.current).toBe('profile-id');
    expect(useStoredUserIdMock).toHaveBeenLastCalledWith(false);
  });

  it('falls back to the id the device holds while the profile has not answered', () => {
    session.storedUserId = 'stored-id';
    const { result } = renderHook(() => useViewerUserId());
    expect(result.current).toBe('stored-id');
    expect(useStoredUserIdMock).toHaveBeenLastCalledWith(true);
  });

  it('is null while neither has answered', () => {
    const { result } = renderHook(() => useViewerUserId());
    expect(result.current).toBeNull();
  });

  it('asks for neither when signed out', () => {
    session.isAuthenticated = false;
    const { result } = renderHook(() => useViewerUserId());
    expect(result.current).toBeNull();
    expect(useProfileMock).toHaveBeenLastCalledWith({ enabled: false });
    expect(useStoredUserIdMock).toHaveBeenLastCalledWith(false);
  });
});
