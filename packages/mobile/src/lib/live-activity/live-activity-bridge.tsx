import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getBoardCapabilities, toBoardName } from '@boardsesh/board-config';
import { resolveClimbRenderBoard } from '../boards/climb-render-board';
import { useQueue } from '../../providers/queue-provider';
import { useBoardConnectionState } from '../../components/ble/use-board-connection-state';
import { useNativeClimbRender } from '../../hooks/use-native-climb-render';
import { useLiveActivity } from './use-live-activity';
import {
  addWidgetQueueNavigateListener,
  addBoardControlListener,
  isAndroidSessionPresence,
} from './live-activity-plugin';

type LiveActivityBridgeProps = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

// Renderless component that mounts useLiveActivity() with the active
// queue + board context, and wires the native `queueNavigate` event
// (fired when the user taps Next/Previous on the Dynamic Island) into
// the queue reducer so the app's currentClimbQueueItem stays in sync
// with the widget.
//
// Mount inside BluetoothProviderWrapper (i.e. only when a board has been
// selected) so a guest user without a board doesn't trigger Live Activity
// authorization prompts at random.
export function LiveActivityBridge({ boardName, layoutId, sizeId, setIds }: LiveActivityBridgeProps) {
  const { state, sessionId, dispatchWidgetNavigation } = useQueue();
  const { t } = useTranslation('session');
  // Board-connection ownership (shared with the in-app lightbulb). Drives the
  // Live Activity lightbulb + Previous/Next visibility: controls show only while
  // THIS device holds the BLE link (connectedByMe); once a peer takes the wall
  // the bulb goes out and the controls hide, leaving just the current climb.
  const { bluetooth, boardConnection, holderDisplayName } = useBoardConnectionState();

  // On-device thumbnail for the Android notification: render the current climb's
  // holds-only PNG via the BoardRenderer native module and layer the bundled board
  // backgrounds — the app's "no-network board art" rule, so the notification never
  // hits the backend. Only the Android foreground service consumes these (iOS
  // fetches its own via ActivityKit), so skip the render on iOS by passing empty
  // frames — useNativeClimbRender then no-ops its render effect instead of doing
  // work iOS discards.
  const displayClimb = state.currentClimbQueueItem?.climb ?? state.queue[0]?.climb ?? null;
  // The queue head can belong to another board — a climb carried over from a
  // board switch, or a party peer's. Rendered against the selected board's
  // placements it matches no holds and the notification thumbnail comes out as
  // bare board art (#5099), so draw it on its own board. A climb with no board
  // metadata falls through to the selected board, as before.
  // The angle only tilts the picture, never which holds exist, so the selected
  // board's angle stands in for a config this component is not handed.
  const notificationBoard = useMemo(
    () => resolveClimbRenderBoard(displayClimb, { boardName, layoutId, sizeId, setIds, angle: 0 })?.boardConfig,
    [displayClimb, boardName, layoutId, sizeId, setIds],
  );
  const { overlayUri, overlayLoadKey, verifyOverlayForNativeUse, backgroundPaths } = useNativeClimbRender({
    frames: isAndroidSessionPresence ? (displayClimb?.frames ?? '') : '',
    boardName: toBoardName(notificationBoard?.boardName ?? boardName) ?? 'kilter',
    layoutId: notificationBoard?.layoutId ?? layoutId,
    sizeId: notificationBoard?.sizeId ?? sizeId,
    setIds: notificationBoard?.setIds ?? setIds,
    // Filled markers read as solid lit dots once scaled into the small notification
    // thumbnail; 384px gives the ~88dp expanded image enough resolution while the
    // service caps the composited bitmap so the RemoteViews stays under the Binder
    // transaction limit.
    filledStyle: true,
    renderWidth: 384,
    // This path goes straight to native bitmap compositing and never mounts an
    // expo-image with onError, so validate/recover it in JS before forwarding.
    verifyOverlayFile: isAndroidSessionPresence,
  });

  // Localized strings for the Android foreground-service notification (channel +
  // Previous/Next + lightbulb actions, and the "on the wall" line). Built here
  // because hooks need a component context; ignored on iOS, where ActivityKit
  // renders its own Swift UI.
  const androidNotification = useMemo(
    () => ({
      channelName: t('mobile.session.notification.channelName'),
      channelDescription: t('mobile.session.notification.channelDescription'),
      contentTitleFallback: t('mobile.session.notification.contentTitleFallback'),
      previousLabel: t('mobile.session.notification.previous'),
      nextLabel: t('mobile.session.notification.next'),
      relightLabel: t('mobile.session.notification.relight'),
      reconnectLabel: t('mobile.session.notification.reconnect'),
      onWallTemplate: t('mobile.session.notification.onWall'),
    }),
    [t],
  );

  useLiveActivity({
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    board: { boardName, layoutId, sizeId, setIds },
    sessionId,
    // Session presence follows real (explicitly started/joined) sessions only —
    // a solo queue never raises the lock-screen widget / Dynamic Island.
    isSessionActive: sessionId !== null,
    // Widget Previous/Next are enabled only while this device holds the board
    // (connectedByMe) — they write BLE to the wall, so a non-holder can't drive.
    // This also gates the App Intents' `navigationAllowed` guard natively.
    // Boards the Swift encoder can't drive (Woods, until #3314) never get them:
    // native would encode the packet itself and light the wrong holds.
    widgetNavigationAllowed: boardConnection === 'connectedByMe' && getBoardCapabilities(boardName).nativeBoardControl,
    isPartySession: sessionId !== null,
    boardConnection,
    holderDisplayName,
    androidNotification,
    androidThumbnailOverlayPath: overlayUri,
    androidThumbnailOverlayLoadKey: overlayLoadKey,
    validateAndroidThumbnailOverlay: verifyOverlayForNativeUse,
    androidThumbnailBackgroundPaths: backgroundPaths,
  });

  // Subscribe to widget Next/Previous taps. Native already advanced the shared
  // index, updated the optimistic Live Activity, and sent the server mutation;
  // this listener brings the JS reducer in line using the ABSOLUTE index native
  // computed (event.currentIndex), not a relative nextClimb()/previousClimb().
  //
  // Why absolute: in a server-authorized session the backend's CurrentClimbChanged
  // broadcast (correlationId 'widget-navigate') often reaches JS before this
  // Darwin event and already moves the current climb. A relative advance would
  // then step a second time → the queue jumps by two. Dispatching the absolute
  // item with the event's correlationId is idempotent (re-applying the same
  // index is a no-op) and registers the correlationId so the racing echo is
  // suppressed. Mirrors web's LiveActivityBridge.
  //
  // Refs keep the listener subscribed once: the queue + dispatch read the latest
  // values without re-running the effect (and re-registering the native listener)
  // on every queue mutation.
  const queueRef = useRef(state.queue);
  queueRef.current = state.queue;
  const dispatchWidgetNavigationRef = useRef(dispatchWidgetNavigation);
  dispatchWidgetNavigationRef.current = dispatchWidgetNavigation;

  useEffect(() => {
    const unsubscribe = addWidgetQueueNavigateListener((event) => {
      const queue = queueRef.current;
      // Out-of-range can arrive if the JS queue and the widget's snapshot have
      // momentarily diverged (e.g. a queue edit mid-tap). Drop it rather than
      // crash or wrap around.
      if (event.currentIndex < 0 || event.currentIndex >= queue.length) return;
      dispatchWidgetNavigationRef.current(queue[event.currentIndex], event.correlationId);
    });
    return unsubscribe;
  }, []);

  // Android-only: a tap on the foreground-service notification's lightbulb. The
  // tri-state-driven receiver tells us which action it wants:
  //  - reconnect (bulb was out): connect to the last board, taking it back from a
  //    peer (Aurora is last-connection-wins). The BLE auto-sender then re-lights
  //    the current climb on connect.
  //  - reassert (bulb was lit): re-push the current climb to the wall.
  // Mirrors the iOS ReconnectBoardIntent / take-control. A ref keeps the listener
  // subscribed once while reading the latest bluetooth context (its identity
  // changes when a board is (de)selected).
  const bluetoothRef = useRef(bluetooth);
  bluetoothRef.current = bluetooth;
  useEffect(() => {
    const unsubscribe = addBoardControlListener((event) => {
      const bluetoothCtx = bluetoothRef.current;
      if (!bluetoothCtx) return;
      if (event.action === 'reconnect') {
        // The connect ATTEMPT is not tracked — Bluetooth Connection Success /
        // Failed record the outcome a few hundred ms later, which is the question
        // the BLE health dashboard actually asks.
        bluetoothCtx.armUndoWallChangeToast();
        // By serial (Aurora) or device id (MoonBoard); neither → adapter picker.
        void bluetoothCtx.connect(
          undefined,
          undefined,
          bluetoothCtx.reconnectSerialForCurrentBoard ?? undefined,
          bluetoothCtx.reconnectDeviceIdForCurrentBoard ?? undefined,
        );
      } else if (event.action === 'reassert') {
        // A re-push of the current climb — no climb change to undo, so no toast.
        bluetoothCtx.reassertWall();
      }
    });
    return unsubscribe;
  }, []);

  return null;
}
