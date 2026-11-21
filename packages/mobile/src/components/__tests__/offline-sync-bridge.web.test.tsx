// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { isAuthenticated: true, isLoading: false },
  account: { userId: 'first-account' as string | undefined },
  useUpdates: vi.fn(),
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => mocks.auth }));
vi.mock('../../hooks/use-current-user-id', () => ({ useStoredUserId: () => mocks.account }));
vi.mock('../../notifications/use-spray-completion-updates', () => ({ useSprayCompletionUpdates: mocks.useUpdates }));
vi.mock('../../lib/offline-engine', () => ({ setOfflineEngineEnabled: vi.fn() }));
vi.mock('../../lib/analytics-offline-engine-state', () => ({ registerOfflineEngineState: vi.fn() }));

import { OfflineSyncBridge } from '../offline-sync-bridge.web';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = { isAuthenticated: true, isLoading: false };
  mocks.account = { userId: 'first-account' };
});

it('passes the browser account to the shared live report updates and follows account changes', () => {
  const { rerender, unmount } = renderHook(() => OfflineSyncBridge());
  expect(mocks.useUpdates).toHaveBeenLastCalledWith(true, 'first-account');
  mocks.account = { userId: 'second-account' };
  rerender();
  expect(mocks.useUpdates).toHaveBeenLastCalledWith(true, 'second-account');
  mocks.auth = { isAuthenticated: true, isLoading: true };
  rerender();
  expect(mocks.useUpdates).toHaveBeenLastCalledWith(false, 'second-account');
  unmount();
});
