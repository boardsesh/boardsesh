import type { ReactNode } from 'react';
import { BluetoothProvider } from './bluetooth-provider';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { isGuestActiveBoard } from '../lib/boards/guest-board-id';
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
  const boardUuid = activeBoard && !isGuestActiveBoard(activeBoard) ? activeBoard.uuid : undefined;

  return (
    <BluetoothProvider
      boardName={activeBoard?.boardType}
      layoutId={activeBoard?.layoutId}
      sizeId={activeBoard?.sizeId}
      setIds={activeBoard?.setIds}
      boardUuid={boardUuid}
    >
      {activeBoard ? (
        <LiveActivityBridge
          boardName={activeBoard.boardType}
          layoutId={activeBoard.layoutId}
          sizeId={activeBoard.sizeId}
          setIds={activeBoard.setIds}
        />
      ) : null}
      {children}
    </BluetoothProvider>
  );
}
