'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { BoardConfig } from '@boardsesh/shared-schema';
import ConfirmAddClimbDialog, {
  type ConfirmAddChoice,
  type ConfirmAddReason,
} from './confirm-add-climb-dialog';
import { decideAdd, deriveAcceptedConfigs } from '@/app/lib/board-config';
import type { ClimbQueueItem } from './types';

/**
 * Outcome of a `requestAdd` call.
 *
 * - `allow` → the incoming climb can be added silently (queue empty, matching
 *   accepted config, or same-or-smaller size under an accepted key).
 * - `add` → the user explicitly confirmed adding despite a board/layout/size
 *   mismatch. Treat identically to `allow` from the caller's perspective.
 * - `switch` → the user asked to switch boards: clear the queue and navigate
 *   to the incoming climb's board. Caller is responsible for doing that.
 * - `cancel` → user dismissed the dialog. Do not add the climb.
 */
export type AddOutcome = 'allow' | 'add' | 'switch' | 'cancel';

interface QueueAddConfirmApi {
  /**
   * Ask the user for confirmation when the incoming `BoardConfig` doesn't
   * match the queue's already-accepted configs. The caller wraps every
   * "add to queue" path through this function. Serializes one dialog at a
   * time — rapid-fire adds queue up behind each other.
   */
  requestConfirm: (reason: ConfirmAddReason, incoming: BoardConfig) => Promise<ConfirmAddChoice>;
  /**
   * High-level gate combining `deriveAcceptedConfigs` + `decideAdd` + the
   * dialog. Resolves to an `AddOutcome`:
   * - `allow`: queue is empty or the incoming config already matches one of
   *   the accepted configs — add silently, no dialog shown.
   * - `add`: the dialog was shown and the user confirmed adding despite a
   *   board/layout/size mismatch.
   * - `switch`: the user asked to clear the queue and switch boards.
   * - `cancel`: the user dismissed the dialog.
   */
  gate: (incoming: BoardConfig, existingQueue: readonly ClimbQueueItem[]) => Promise<AddOutcome>;
}

const QueueAddConfirmContext = createContext<QueueAddConfirmApi | undefined>(undefined);

/**
 * Consumer hook for the confirm dialog. Returns `null` when the provider
 * is not mounted — callers can short-circuit to "no confirmation needed".
 */
export function useQueueAddConfirm(): QueueAddConfirmApi | null {
  return useContext(QueueAddConfirmContext) ?? null;
}

interface PendingRequest {
  reason: ConfirmAddReason;
  incoming: BoardConfig;
  resolve: (choice: ConfirmAddChoice) => void;
}

export function QueueAddConfirmProvider({ children }: { children: React.ReactNode }) {
  // Queue of pending requests — only one dialog shows at a time. Subsequent
  // requests wait in line. Prevents overlapping modals when the user bulk-adds.
  const pendingQueueRef = useRef<PendingRequest[]>([]);
  const [activeRequest, setActiveRequest] = useState<PendingRequest | null>(null);

  const advance = useCallback(() => {
    const next = pendingQueueRef.current.shift() ?? null;
    setActiveRequest(next);
  }, []);

  const requestConfirm = useCallback(
    (reason: ConfirmAddReason, incoming: BoardConfig): Promise<ConfirmAddChoice> => {
      return new Promise<ConfirmAddChoice>((resolve) => {
        const request: PendingRequest = { reason, incoming, resolve };
        if (activeRequest) {
          pendingQueueRef.current.push(request);
        } else {
          setActiveRequest(request);
        }
      });
    },
    [activeRequest],
  );

  const handleChoice = useCallback(
    (choice: ConfirmAddChoice) => {
      const current = activeRequest;
      if (!current) return;
      current.resolve(choice);
      advance();
    },
    [activeRequest, advance],
  );

  const gate = useCallback(
    async (
      incoming: BoardConfig,
      existingQueue: readonly ClimbQueueItem[],
    ): Promise<AddOutcome> => {
      const { accepted, acceptedSizes } = deriveAcceptedConfigs(existingQueue);
      const decision = decideAdd(incoming, accepted, acceptedSizes);
      if (decision.kind === 'allow') return 'allow';
      const choice = await requestConfirm(decision.reason, incoming);
      return choice;
    },
    [requestConfirm],
  );

  const api = useMemo<QueueAddConfirmApi>(() => ({ requestConfirm, gate }), [requestConfirm, gate]);

  return (
    <QueueAddConfirmContext.Provider value={api}>
      {children}
      <ConfirmAddClimbDialog
        open={activeRequest !== null}
        reason={activeRequest?.reason ?? null}
        incoming={activeRequest?.incoming ?? null}
        onChoose={handleChoice}
      />
    </QueueAddConfirmContext.Provider>
  );
}
