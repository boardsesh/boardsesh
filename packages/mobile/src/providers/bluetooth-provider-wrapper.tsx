import type { ReactNode } from 'react';
import { QUANTUM_MODELS, type QuantumModelName } from '@boardsesh/board-constants/quantum';
import { BluetoothProvider } from './bluetooth-provider';
import { QuantumBluetoothProvider } from './quantum-bluetooth-provider';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { LiveActivityBridge } from '../lib/live-activity/live-activity-bridge';

/**
 * Supplies the active board to BluetoothProvider for the whole navigation
 * subtree.
 *
 * `useActiveBoard` reads the stored board from AsyncStorage asynchronously, so
 * on every cold start `activeBoard` is `undefined` for the first commit and then
 * resolves one tick later. BluetoothProvider is therefore mounted
 * **unconditionally** — all its props are optional and a board connection is
 * user-initiated, so the provider is inert without a board. Swapping the element
 * at this position from a Fragment (no board) to BluetoothProvider (board
 * resolved) would change the element type at a fixed tree position, forcing
 * React to unmount and remount everything below it (the navigation Stack,
 * DeepLinkProvider, ShareTargetProvider, OnboardingGate, the analytics screen
 * tracker, …) once per launch for any returning user. Keeping the provider
 * stable across the `undefined → board` transition avoids that remount storm.
 *
 * The LiveActivityBridge is the only child that genuinely needs a board (it
 * would otherwise trigger Live Activity authorization prompts for a guest), so
 * it alone is gated on `activeBoard`.
 */
export function BluetoothProviderWrapper({ children }: { children: ReactNode }) {
  const { data: activeBoard } = useActiveBoard();
  const quantumModelId =
    activeBoard?.boardType === 'quantum'
      ? ((Object.entries(QUANTUM_MODELS).find(
          ([, model]) => model.layoutId === activeBoard.layoutId && model.sizeId === activeBoard.sizeId,
        )?.[0] as QuantumModelName | undefined) ?? null)
      : null;
  const legacyActiveBoard = activeBoard?.boardType === 'quantum' ? undefined : activeBoard;

  return (
    <QuantumBluetoothProvider selectedModelId={quantumModelId} preferredSerial={activeBoard?.serialNumber}>
      <BluetoothProvider
        boardName={legacyActiveBoard?.boardType}
        layoutId={legacyActiveBoard?.layoutId}
        sizeId={legacyActiveBoard?.sizeId}
        setIds={legacyActiveBoard?.setIds}
        boardUuid={legacyActiveBoard?.uuid}
      >
        {legacyActiveBoard ? (
          <LiveActivityBridge
            boardName={legacyActiveBoard.boardType}
            layoutId={legacyActiveBoard.layoutId}
            sizeId={legacyActiveBoard.sizeId}
            setIds={legacyActiveBoard.setIds}
          />
        ) : null}
        {children}
      </BluetoothProvider>
    </QuantumBluetoothProvider>
  );
}
