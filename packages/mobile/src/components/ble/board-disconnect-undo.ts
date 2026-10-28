import { createContext, useContext } from 'react';
import type { AccessoryPlacement } from '../../lib/analytics-board-connect';
import type { LightbulbSurface } from './use-lightbulb-control';

/**
 * The board a connect should go straight to: by serial (Aurora) or BLE device id
 * (MoonBoard). Neither set means the connect opens the device picker.
 */
export type ReconnectTarget = { serial?: string; deviceId?: string };

/**
 * What a bulb's short-tap disconnect hands the undo snackbar (#6940). The
 * target is read BEFORE the disconnect, because a deliberate disconnect forgets
 * the remembered board: after it, `reconnectSerialForCurrentBoard` is null and a
 * plain connect would open the picker instead of relighting the same board.
 */
export type BoardDisconnectUndoOffer = {
  /** The bulb that disconnected; the undo's Board Connect Tapped reports it. */
  surface: LightbulbSurface;
  placement?: AccessoryPlacement;
  target: ReconnectTarget;
  /** `boardBluetoothKey` at the tap. The offer drops when the route moves to another board. */
  boardKey: string;
};

export type BoardDisconnectUndoActions = {
  offerUndo: (offer: BoardDisconnectUndoOffer) => void;
};

export const BoardDisconnectUndoContext = createContext<BoardDisconnectUndoActions | null>(null);

/**
 * Null outside `BoardDisconnectUndoProvider` (isolated renders, tests): the bulb
 * then disconnects with no undo, exactly as before.
 */
export function useBoardDisconnectUndo(): BoardDisconnectUndoActions | null {
  return useContext(BoardDisconnectUndoContext);
}

/** Which board config the Bluetooth provider is scoped to, as one comparable string. */
export function boardBluetoothKey(bluetooth: {
  boardName: string | undefined;
  layoutId?: number;
  sizeId?: number;
}): string {
  return `${bluetooth.boardName ?? ''}:${bluetooth.layoutId ?? ''}:${bluetooth.sizeId ?? ''}`;
}
