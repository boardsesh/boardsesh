// The Rogue gym timer's context, apart from its provider so a reader (the
// pairing sheet, Settings › Timers) doesn't pull the provider's BLE and queue
// graph in with it. The provider is rogue-timer-provider.tsx.

import { createContext, useContext } from 'react';

export type RogueTimerStatus = 'idle' | 'connecting' | 'connected' | 'error';

/**
 * Starts a pairing scan, called once the scan slot is free. `releaseSlot` hands
 * the slot back when the scan stops by itself; the returned function stops it.
 */
export type RogueTimerPairingScanStarter = (releaseSlot: () => void) => () => void;

export type RogueTimerContextValue = {
  status: RogueTimerStatus;
  isConnected: boolean;
  deviceName: string | undefined;
  /**
   * Run a pairing scan in the radio's one scan slot: after any reconnect in
   * flight, holding off new ones until it stops. Returns the stop function.
   */
  schedulePairingScan: (startScan: RogueTimerPairingScanStarter) => () => void;
};

export const RogueTimerContext = createContext<RogueTimerContextValue | undefined>(undefined);

export function useRogueTimer(): RogueTimerContextValue {
  const ctx = useContext(RogueTimerContext);
  if (!ctx) throw new Error('useRogueTimer must be used within a RogueTimerProvider');
  return ctx;
}

/** Non-throwing variant for consumers that may render outside the provider. */
export function useOptionalRogueTimer(): RogueTimerContextValue | null {
  return useContext(RogueTimerContext) ?? null;
}
