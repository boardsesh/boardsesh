import { useMemo, useCallback, useRef } from 'react';
import { useSnackbar } from '../../providers/snackbar-provider';
import type { ConnectionState } from '../../connection-manager/websocket-connection-manager';

interface UseMutationGuardParams {
  sessionId: string | null;
  backendUrl: string | null;
  hasConnected: boolean;
  connectionState: ConnectionState;
  isSessionActive: boolean;
  isSessionReady: boolean;
}

/**
 * Determines view-only mode and provides a guard function that blocks
 * mutations when the session has never connected. Once connected,
 * mutations are allowed even when offline (applied locally).
 * Shows a debounced toast when blocked.
 */
export function useMutationGuard({
  sessionId,
  backendUrl,
  hasConnected,
  connectionState,
  isSessionActive,
  isSessionReady,
}: UseMutationGuardParams) {
  const { showMessage } = useSnackbar();

  // View-only only before first connection. Once connected, user can always
  // modify the queue locally (offline changes are reconciled on reconnect).
  const viewOnlyMode = useMemo(() => {
    if (!sessionId) return false;
    if (!backendUrl) return false;
    return !hasConnected;
  }, [sessionId, backendUrl, hasConnected]);

  // True when we were connected but the WebSocket is now disconnected.
  // Covers both true network-offline and server-down scenarios.
  const isDisconnected = useMemo(() => {
    return !!sessionId && hasConnected && connectionState !== 'connected';
  }, [sessionId, hasConnected, connectionState]);

  // Allow mutations when: not view-only AND (session ready OR disconnected with prior connection OR solo mode)
  const canMutate = !viewOnlyMode && (sessionId ? (isSessionReady || isDisconnected) : true);

  // Ref to debounce the "blocked" toast so rapid taps don't spam
  const lastBlockedToastRef = useRef(0);

  const guardMutation = useCallback((): boolean => {
    if (!sessionId || canMutate) return false;
    const now = Date.now();
    if (now - lastBlockedToastRef.current > 3000) {
      showMessage('Reconnecting to session — try again in a moment.', 'warning');
      lastBlockedToastRef.current = now;
    }
    return true;
  }, [sessionId, canMutate, showMessage]);

  return { viewOnlyMode, canMutate, guardMutation, isDisconnected };
}
