import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

import { useMutationGuard } from '../use-mutation-guard';
import type { ConnectionState } from '../../../connection-manager/websocket-connection-manager';

interface TestParams {
  sessionId: string | null;
  backendUrl: string | null;
  hasConnected: boolean;
  connectionState: ConnectionState;
  isSessionActive: boolean;
  isSessionReady: boolean;
}

const defaultParams: TestParams = {
  sessionId: null,
  backendUrl: 'wss://example.com/graphql',
  hasConnected: false,
  connectionState: 'idle',
  isSessionActive: false,
  isSessionReady: false,
};

describe('useMutationGuard', () => {
  beforeEach(() => {
    mockShowMessage.mockClear();
  });

  describe('solo mode (no session)', () => {
    it('viewOnlyMode is false, guardMutation allows, isDisconnected is false', () => {
      const { result } = renderHook(() =>
        useMutationGuard({ ...defaultParams, sessionId: null }),
      );

      expect(result.current.viewOnlyMode).toBe(false);
      expect(result.current.isDisconnected).toBe(false);
      expect(result.current.guardMutation()).toBe(false); // allowed
    });
  });

  describe('session, not yet connected', () => {
    it('viewOnlyMode is true, guardMutation blocks, isDisconnected is false', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: false,
          connectionState: 'connecting',
          isSessionActive: false,
          isSessionReady: false,
        }),
      );

      expect(result.current.viewOnlyMode).toBe(true);
      expect(result.current.isDisconnected).toBe(false);
      expect(result.current.canMutate).toBe(false);
      expect(result.current.guardMutation()).toBe(true); // blocked
    });
  });

  describe('session, connected and ready', () => {
    it('viewOnlyMode is false, guardMutation allows, isDisconnected is false', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: true,
          connectionState: 'connected',
          isSessionActive: true,
          isSessionReady: true,
        }),
      );

      expect(result.current.viewOnlyMode).toBe(false);
      expect(result.current.isDisconnected).toBe(false);
      expect(result.current.canMutate).toBe(true);
      expect(result.current.guardMutation()).toBe(false); // allowed
    });
  });

  describe('session, was connected, now reconnecting', () => {
    it('viewOnlyMode is false, guardMutation allows, isDisconnected is true', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: true,
          connectionState: 'reconnecting',
          isSessionActive: true,
          isSessionReady: false,
        }),
      );

      expect(result.current.viewOnlyMode).toBe(false);
      expect(result.current.isDisconnected).toBe(true);
      expect(result.current.canMutate).toBe(true);
      expect(result.current.guardMutation()).toBe(false); // allowed
    });
  });

  describe('session, was connected, now stale', () => {
    it('isDisconnected is true, mutations allowed', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: true,
          connectionState: 'stale',
          isSessionActive: true,
          isSessionReady: false,
        }),
      );

      expect(result.current.isDisconnected).toBe(true);
      expect(result.current.canMutate).toBe(true);
      expect(result.current.guardMutation()).toBe(false); // allowed
    });
  });

  describe('session, was connected, error state', () => {
    it('isDisconnected is true, mutations allowed', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: true,
          connectionState: 'error',
          isSessionActive: true,
          isSessionReady: false,
        }),
      );

      expect(result.current.isDisconnected).toBe(true);
      expect(result.current.canMutate).toBe(true);
      expect(result.current.guardMutation()).toBe(false); // allowed
    });
  });

  describe('toast behavior', () => {
    it('shows toast when guardMutation blocks (never connected)', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: false,
          connectionState: 'connecting',
          isSessionActive: false,
          isSessionReady: false,
        }),
      );

      act(() => {
        result.current.guardMutation();
      });

      expect(mockShowMessage).toHaveBeenCalledWith(
        expect.stringContaining('Reconnecting'),
        'warning',
      );
    });

    it('debounces toast within 3 seconds', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: false,
          connectionState: 'connecting',
          isSessionActive: false,
          isSessionReady: false,
        }),
      );

      act(() => {
        result.current.guardMutation();
        result.current.guardMutation();
        result.current.guardMutation();
      });

      // Only one toast shown due to debounce
      expect(mockShowMessage).toHaveBeenCalledTimes(1);
    });

    it('does not show toast when mutation is allowed (offline but previously connected)', () => {
      const { result } = renderHook(() =>
        useMutationGuard({
          ...defaultParams,
          sessionId: 'session-1',
          hasConnected: true,
          connectionState: 'reconnecting',
          isSessionActive: true,
          isSessionReady: false,
        }),
      );

      act(() => {
        result.current.guardMutation();
      });

      expect(mockShowMessage).not.toHaveBeenCalled();
    });
  });
});
