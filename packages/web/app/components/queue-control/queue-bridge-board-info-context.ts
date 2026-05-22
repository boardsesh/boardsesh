'use client';

import { createContext, useContext } from 'react';
import type { Angle, BoardDetails } from '@/app/lib/types';

export type QueueBridgeBoardInfo = {
  boardDetails: BoardDetails | null;
  angle: Angle;
  /**
   * Whether `angle` came from a real source (route / session boardPath /
   * local current-climb angle) vs the `?? 0` solo fallback. Log paths
   * (see `useEffectiveAngle`) must distinguish these so a degenerate
   * "solo, off-board, no current climb" state doesn't silently log a
   * tick at 0°. Existing consumers that treat 0° as a real angle for
   * vertical boards keep working — they just read `angle` directly;
   * only the log path inspects the resolved flag.
   */
  hasResolvedAngle: boolean;
  hasActiveQueue: boolean;
  /**
   * True once the persistent session has finished restoring from IndexedDB
   * (or immediately when a board-route injector is active). Consumers that
   * want to read `hasActiveQueue`/`boardDetails` on mount must wait for this
   * flag — otherwise they race the async restore and see stale defaults.
   */
  isHydrated: boolean;
};

export const QueueBridgeBoardInfoContext = createContext<QueueBridgeBoardInfo>({
  boardDetails: null,
  angle: 0,
  hasResolvedAngle: false,
  hasActiveQueue: false,
  isHydrated: false,
});

export function useQueueBridgeBoardInfo() {
  return useContext(QueueBridgeBoardInfoContext);
}
