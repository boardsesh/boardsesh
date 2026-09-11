import { AppState } from 'react-native';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getBoardCapabilities, toBoardName, boardSupportsMirroring } from '@boardsesh/board-config';
import { nativeBleSupportsBoard } from '../ble/adapter-factory';
import { requestedBoardRenderMode, useBoardRenderSettings } from '../board-render-settings';
import { resolveClimbRenderBoard } from '../boards/climb-render-board';
import { useQueue } from '../../providers/queue-provider';
import { useBoardConnectionState } from '../../components/ble/use-board-connection-state';
import { useNativeClimbRender } from '../../hooks/use-native-climb-render';
import { useLiveActivity } from './use-live-activity';
import {
  addWidgetMirrorListener,
  getPendingWidgetMirror,
  acknowledgeWidgetMirror,
  acknowledgeWidgetMirrorRequest,
  type WidgetMirrorEvent,
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
  const { state, sessionId, dispatchWidgetNavigation, mirrorCurrentClimb, dispatchWidgetMirror } = useQueue();
  const { t } = useTranslation('session');
  // Board-connection ownership (shared with the in-app lightbulb). Drives the
  // Live Activity lightbulb + Previous/Next visibility: controls show only while
  // THIS device holds the BLE link (connectedByMe); once a peer takes the wall
  // the bulb goes out and the controls hide, leaving just the current climb.
  const { bluetooth, boardConnection, holderDisplayName } = useBoardConnectionState();
  // The climber's saved board look for the iOS server-rendered thumbnail. The
  // REQUESTED mode, not the device-probed effective one: the server always
  // renders aura. Pre-hydration the store snapshot resolves to the default
  // (aura); if a classic preference hydrates later, the update path repairs
  // the App Group value — no need to gate on `loaded`.
  const { settings: boardRenderSettings } = useBoardRenderSettings();
  const renderMode = requestedBoardRenderMode(boardRenderSettings);

  // On-device thumbnail for the Android notification: render the current climb's
  // holds-only PNG via the BoardRenderer native module and layer the bundled board
  // backgrounds — the app's "no-network board art" rule, so the notification never
  // hits the backend. Only the Android foreground service consumes these (iOS
  // fetches its own via ActivityKit), so skip the render on iOS by passing empty
  // frames — useNativeClimbRender then no-ops its render effect instead of doing
  // work iOS discards.
  const displayClimb = state.currentClimbQueueItem?.climb ?? state.queue[0]?.climb ?? null;
  // The selected board as a config, memoised on its primitives. Its own identity
  // is what keys the resolver's compatibility-target memo, so a literal built
  // inline would miss that cache on every render. The angle only tilts the
  // picture, never which holds exist, so 0 stands in for an angle this component
  // is not handed.
  const selectedBoardConfig = useMemo(
    () => ({ boardName, layoutId, sizeId, setIds, angle: 0 }),
    [boardName, layoutId, sizeId, setIds],
  );
  // The queue head can belong to another board — a climb carried over from a
  // board switch, or a party peer's. Rendered against the selected board's
  // placements it matches no holds and the notification thumbnail comes out as
  // bare board art (#5099), so draw it on its own board. A climb with no board
  // metadata falls through to the selected board, as before.
  const notificationBoard = useMemo(
    () => resolveClimbRenderBoard(displayClimb, selectedBoardConfig)?.boardConfig,
    [displayClimb, selectedBoardConfig],
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
      mirrorLabel: t('mobile.session.notification.mirror'),
      unmirrorLabel: t('mobile.session.notification.unmirror'),
      relightLabel: t('mobile.session.notification.relight'),
      reconnectLabel: t('mobile.session.notification.reconnect'),
      onWallTemplate: t('mobile.session.notification.onWall'),
    }),
    [t],
  );

  useLiveActivity({
    queueSequence: state.serverSequence,
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
    // Two board gates: the static product capability, and whether THIS binary's
    // Swift encoder actually drives the board (nativeBleSupportsBoard — an
    // OTA'd JS can be newer than the installed native build; the old Swift
    // layer would encode a Woods packet as Aurora and light the wrong holds).
    widgetNavigationAllowed:
      boardConnection === 'connectedByMe' &&
      getBoardCapabilities(boardName).nativeBoardControl &&
      nativeBleSupportsBoard(boardName),
    isPartySession: sessionId !== null,
    boardConnection,
    holderDisplayName,
    renderMode,
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

  const handleMirrorRef = useRef<(event: WidgetMirrorEvent) => Promise<void>>(async () => {});
  handleMirrorRef.current = async (event) => {
    if (event.sessionId !== sessionId) return;
    if (event.kind === 'confirmed') {
      // Native already changed the wall. Replay the sequenced result, never toggle again.
      if (await dispatchWidgetMirror(event)) await acknowledgeWidgetMirror(event.sessionId, event.sequence);
      return;
    }
    if (!boardSupportsMirroring(boardName, layoutId)) return;
    if (state.currentClimbQueueItem?.uuid !== event.queueItemUuid) {
      // The queue moved on, so the server would refuse this anyway. Retire an
      // iOS tap parked by a failed request rather than replaying it forever.
      await acknowledgeWidgetMirrorRequest(event.sessionId);
      return;
    }
    // Not holding the board yet is a timing condition, not a verdict: a parked
    // tap replayed during a cold launch can arrive before Bluetooth reconnects,
    // so leave it parked for the next handover instead of acknowledging it.
    if (boardConnection !== 'connectedByMe') return;
    // Only a server-accepted replay retires the parked tap. The mutation turns
    // a failure into a toast, which on a locked phone nobody sees, so acking
    // unconditionally would throw the tap away in exactly the outage it exists
    // to survive.
    if (await mirrorCurrentClimb(event.mirrored, event.queueItemUuid)) {
      await acknowledgeWidgetMirrorRequest(event.sessionId);
    }
  };
  useEffect(() => {
    const receive = (event: WidgetMirrorEvent) => {
      void handleMirrorRef
        .current(event)
        .catch((error: unknown) => console.warn('[LiveActivity] Mirror sync failed:', error));
    };
    const replay = () => {
      void getPendingWidgetMirror().then((event) => {
        if (event) receive(event);
      });
    };
    const unsubscribe = addWidgetMirrorListener(receive);
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') replay();
    });
    replay();
    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [sessionId]);

  useEffect(() => {
    void getPendingWidgetMirror()
      .then((event) => {
        if (event) return handleMirrorRef.current(event);
      })
      .catch((error: unknown) => console.warn('[LiveActivity] Mirror replay failed:', error));
  }, [state.queue]);

  return null;
}
