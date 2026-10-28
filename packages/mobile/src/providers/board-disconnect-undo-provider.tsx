import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import { Portal } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { UndoSnackbar } from '../components/UndoSnackbar';
import {
  BoardDisconnectUndoContext,
  boardBluetoothKey,
  type BoardDisconnectUndoActions,
  type BoardDisconnectUndoOffer,
} from '../components/ble/board-disconnect-undo';
import { useLightbulbControl } from '../components/ble/use-lightbulb-control';
import { useBottomChromeMetrics } from '../hooks/use-bottom-chrome-metrics';
import { hapticError } from '../lib/haptics';
import { spacing } from '../theme/tokens';

/** As long as the wall-change undo: the climber may already be walking to the wall. */
export const BOARD_DISCONNECT_UNDO_MS = 8000;

type ActiveOffer = BoardDisconnectUndoOffer & { nonce: number };

/**
 * "Board disconnected · Undo" after a bulb's short-tap disconnect (#6940). One
 * host for every bulb (MiniPlayer, toolbar, app bar, header pill, player), so a
 * bulb that unmounts on disconnect (the header pill only shows while you hold
 * the board) still leaves its undo behind.
 *
 * The snackbar draws in a `FullWindowOverlay` on iOS, like the logbook delete
 * undo: the player is a native modal there and the root toast overlay and Paper
 * portal draw behind it, so a portal would hide the undo for the player's own
 * bulb. Android keeps the Paper portal.
 */
export function BoardDisconnectUndoProvider({ children }: { children: ReactNode }) {
  const [offer, setOffer] = useState<ActiveOffer | null>(null);
  const nonceRef = useRef(0);
  const offerUndo = useCallback((next: BoardDisconnectUndoOffer) => {
    nonceRef.current += 1;
    setOffer({ ...next, nonce: nonceRef.current });
  }, []);
  const clearOffer = useCallback(() => setOffer(null), []);
  const actions = useMemo<BoardDisconnectUndoActions>(() => ({ offerUndo }), [offerUndo]);

  return (
    <BoardDisconnectUndoContext value={actions}>
      {children}
      {offer ? <BoardDisconnectUndoSnackbar key={offer.nonce} offer={offer} onDone={clearOffer} /> : null}
    </BoardDisconnectUndoContext>
  );
}

/**
 * Mounted only while an offer stands, so the BLE state it reads re-renders this
 * small component and never the bulbs' screens. Undo runs the bulbs' own
 * connect (`useLightbulbControl().connect`) against the captured board, read
 * fresh at the tap: the same gate, Board Connect Tapped and undo-arming as a
 * tap on a dark bulb.
 */
function BoardDisconnectUndoSnackbar({ offer, onDone }: { offer: ActiveOffer; onDone: () => void }) {
  const { t } = useTranslation('settings');
  const { t: tSession } = useTranslation('session');
  const bottomChrome = useBottomChromeMetrics();
  const { connect, pressAction, localConnected, bluetooth } = useLightbulbControl({
    surface: offer.surface,
    placement: offer.placement,
  });

  // The link came back some other way (the bulb, Live Activity, a reconnect):
  // nothing left to undo. Waits to see the link drop first, because the offer
  // can mount on the render before the disconnect lands.
  const sawDisconnectedRef = useRef(false);
  useEffect(() => {
    if (!localConnected) {
      sawDisconnectedRef.current = true;
      return;
    }
    if (sawDisconnectedRef.current) onDone();
  }, [localConnected, onDone]);

  // Another board (or none): the captured serial belongs to the old one, and
  // connecting it under the new config would light the wrong LED map.
  const boardKey = bluetooth ? boardBluetoothKey(bluetooth) : null;
  useEffect(() => {
    if (boardKey !== offer.boardKey) onDone();
  }, [boardKey, offer.boardKey, onDone]);

  // `connect` runs only for a 'connect' press action. Anything else (the
  // hang-up still settling, a peer who took the wall since) would make it
  // resolve false without trying, so the snackbar stays up, with a buzz, rather
  // than vanishing as if the board were back. A connect that starts and then
  // fails reports itself the way any bulb connect does.
  const handleUndo = useCallback(() => {
    if (pressAction !== 'connect') {
      hapticError();
      return;
    }
    onDone();
    void connect(offer.surface, { target: offer.target, placement: offer.placement, undo: true });
  }, [connect, offer, onDone, pressAction]);

  const snackbar = (
    <UndoSnackbar
      visible
      nonce={offer.nonce}
      message={t('ble.barControl.disconnectedLabel')}
      undoLabel={tSession('mobile.boardPresence.undo')}
      undoAccessibilityLabel={t('ble.barControl.undoDisconnectAria')}
      onUndo={handleUndo}
      onDismiss={onDone}
      duration={BOARD_DISCONNECT_UNDO_MS}
      bottom={bottomChrome.floatingControlBottom + spacing[2]}
    />
  );

  return Platform.OS === 'ios' ? (
    <FullWindowOverlay>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {snackbar}
      </View>
    </FullWindowOverlay>
  ) : (
    <Portal>{snackbar}</Portal>
  );
}
