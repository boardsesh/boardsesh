'use client';

import { useCallback } from 'react';
import type { RecordBoardSendInput } from '@boardsesh/shared-schema';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  RECORD_BOARD_SEND_MUTATION,
  type RecordBoardSendResponse,
  type RecordBoardSendVariables,
} from '@/app/components/board-history/board-history-operations';
import { useWsAuthToken } from './use-ws-auth-token';

/**
 * Generate a uuid v4 for the recordBoardSend idempotency key. Uses the
 * browser/Node `crypto.randomUUID()` where available (every supported
 * runtime in this app, including iOS WKWebView) with a degenerate
 * fallback for the SSR no-op case so the hook stays importable in
 * server-rendered trees even though it never actually fires there.
 */
function generateClientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — never expected to run in practice. Random-enough to keep the
  // server's ON CONFLICT (uuid) DO NOTHING from collapsing distinct sends
  // into one history row under any conceivable code path.
  return `bs-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Fire-and-forget hook that records a successful BLE send to the
 * `board_climb_history` log. The caller supplies the send context (board
 * serial, climb uuid, angle, etc.); the hook generates a client-side
 * idempotency uuid and dispatches the mutation.
 *
 * Failures are swallowed and surfaced via console.warn — board history is a
 * "nice to have" log, not a critical write path. The BLE send already
 * succeeded by the time this fires; failing to record it must not interfere
 * with the user's session.
 */
export function useRecordBoardSend(): {
  recordSend: (input: Omit<RecordBoardSendInput, 'uuid'>) => Promise<void>;
} {
  const { token } = useWsAuthToken();

  const recordSend = useCallback(
    async (input: Omit<RecordBoardSendInput, 'uuid'>): Promise<void> => {
      if (!token) {
        // Unauthenticated users can still send to a board via BLE but cannot
        // write to the history log. Silently skip — the soft pairing gate
        // would reject the mutation anyway.
        return;
      }
      const client = createGraphQLHttpClient(token);
      try {
        await client.request<RecordBoardSendResponse, RecordBoardSendVariables>(RECORD_BOARD_SEND_MUTATION, {
          input: { ...input, uuid: generateClientUuid() },
        });
      } catch (err) {
        // Non-fatal: history is best-effort. Log so it shows up in Sentry's
        // console breadcrumb chain without crashing the BLE auto-sender.
        console.warn('[recordBoardSend] failed to record send:', err);
      }
    },
    [token],
  );

  return { recordSend };
}
