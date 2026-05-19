'use client';

import { useCallback } from 'react';
import { triggerManualSend, useBluetoothConnectedStatus } from '../board-bluetooth-control/bluetooth-status-store';
import { useCurrentClimb } from '../graphql-queue';

/**
 * Send the user's current local pick to the connected board.
 *
 * The BLE auto-sender effect only fires when `currentClimbQueueItem`
 * *changes*. When the user wants to re-send the pick that's already current
 * locally — most commonly after someone else (or themselves on another
 * device) has displaced what's on the wall — we need an explicit re-send
 * path that doesn't depend on a state change.
 *
 * This hook delegates to the module-level `triggerManualSend()` registered
 * by the active `BluetoothProvider`. The provider's `BluetoothAutoSender`
 * already wires the same `sendFramesToBoard` + analytics + `recordBoardSend`
 * path as the auto-sender — so the manual re-send produces the same
 * downstream effects (per-board history append + telemetry) as a regular
 * climb change.
 *
 * Using the module-level registry (instead of `useBluetoothContext()`)
 * means this hook is safe to call from surfaces that live outside the
 * BluetoothProvider tree — notably the play-view drawer header, which is
 * rendered from the root-level QueueControlBar.
 *
 * No-ops when:
 * - No local pick exists (nothing to send)
 * - The board isn't BLE-connected (no registered sender)
 *
 * The CTA in the UI is conditionally rendered on both of those, so the
 * guards here are defensive — they keep the hook safe to call from any
 * surface without needing to pre-check.
 */
export function useSendLocalPick(): { sendLocalPick: () => Promise<void> } {
  const isBluetoothConnected = useBluetoothConnectedStatus();
  const { currentClimbQueueItem } = useCurrentClimb();

  const sendLocalPick = useCallback(async (): Promise<void> => {
    if (!isBluetoothConnected) return;
    if (!currentClimbQueueItem) return;
    await triggerManualSend();
  }, [isBluetoothConnected, currentClimbQueueItem]);

  return { sendLocalPick };
}
