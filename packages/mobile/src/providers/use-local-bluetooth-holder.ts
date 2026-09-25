import { useEffect, useRef } from 'react';

type LocalHolderScope = {
  boardId: number | null;
  sessionId: string | null;
  holderUserId: string | null;
};

/** Provider-owned history: a newly mounted control can recognize a delayed self-release. */
export function useLocalBluetoothHolder({
  boardId,
  sessionId,
  holderUserId,
  isConnected,
}: LocalHolderScope & { isConnected: boolean }): string | null {
  const lastLocalHolder = useRef<LocalHolderScope | null>(null);
  const sameScope = lastLocalHolder.current?.boardId === boardId && lastLocalHolder.current?.sessionId === sessionId;
  // Ignore old scope memory on this render; an effect-only reset would leave
  // consumers with a stale action until an unrelated update rendered them again.
  const rememberedUserId = sameScope ? (lastLocalHolder.current?.holderUserId ?? null) : null;
  const localHolderUserId = isConnected && holderUserId !== null ? holderUserId : rememberedUserId;

  useEffect(() => {
    lastLocalHolder.current = { boardId, sessionId, holderUserId: localHolderUserId };
  }, [boardId, sessionId, localHolderUserId]);

  return localHolderUserId;
}
