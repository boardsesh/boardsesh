import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import {
  classifyClimbBoardCompatibility,
  findNextCompatibleQueueItem,
  formatBoardDisplayName,
  toBoardName,
  type ActiveBoardForCompatibility,
} from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useBoardPresenceCurrent } from '@boardsesh/board-presence-react';
import type { BoardPresenceClimb, ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { emitWallConfirm } from '@boardsesh/play-view';
import {
  useBoardBluetooth,
  boardConfigKey,
  type BleConnectionHandle,
  type BleConnectionEnded,
  type BluetoothDisconnectReason,
  type SendFramesToBoard,
} from '../lib/ble/use-board-bluetooth';
import { hasRenderableFrames } from '../lib/ble/renderable-frames';
import { useResolvedBleDeviceBoards } from '../lib/ble/resolve-serials';
import { classifyBleDisconnect } from '../lib/ble/disconnect-category';
import {
  decideBlePickerSelection,
  type BleBoardConfig,
  type PickerSelectionDecision,
} from '../lib/ble/board-config-match';
import { summarizePickerResolution, type PickerResolutionStats } from '../lib/ble/picker-resolution-stats';
import { getAndroidLocationPermissionState } from '../lib/ble/android-location-permission';
import { useSetActiveBoard } from '../lib/graphql/use-active-board';
import { getHttpClient } from '../lib/graphql/client';
import { GET_BOARD, GET_PROFILE } from '../lib/graphql/operations';
import type { GetBoardQueryResponse, GetProfileQueryResponse } from '../lib/graphql/operations';
import { getBoardRenderData } from '../lib/board-details';
import { registerBluetoothConnection } from '../lib/ble/bluetooth-status-store';
import { reportHandledError } from '../lib/error-reporting';
import { useQueue, useQueueActions, useQueueSessionControls } from './queue-provider';
import { useBoardPresenceControls } from './board-presence-provider';
import { useQueueSnackbar } from './queue-snackbar-provider';
import { useToast } from './toast-provider';
import { toClimbInput } from '../lib/climb-to-queue-item';
import { hapticLight, hapticSuccess } from '../lib/haptics';
import { DevicePickerSheet } from '../components/ble/DevicePickerSheet';
import { BlePickerHostContext, type BlePickerHostValue } from './ble-picker-host';
import { track } from '../lib/analytics';
import { getBluetoothColorOverrides, useHoldColorOverrides } from '../lib/hold-color-overrides';
import { useSetting } from '../settings';
import { AutoDisconnectController } from '../lib/ble/auto-disconnect-controller';
import { createBleWriteActivityStore } from '../lib/ble/write-activity-store';
import { BluetoothWriteActivityProvider } from './bluetooth-write-activity';

type BluetoothContextValue = {
  isConnected: boolean;
  loading: boolean;
  connect: (
    initialFrames?: string,
    mirrored?: boolean,
    targetSerial?: string,
    targetDeviceId?: string,
  ) => Promise<boolean>;
  disconnect: (reason?: BluetoothDisconnectReason) => Promise<void>;
  sendFramesToBoard: SendFramesToBoard;
  clearBoard: () => Promise<boolean | undefined>;
  /**
   * Force the auto-sender to re-push the current climb to the wall once, even
   * when the rendered pixels are byte-identical to the last send (which it
   * normally dedups). The lightbulb tap calls this so re-taking control of an
   * unchanged climb re-lights the wall — and, if the link is secretly dead, the
   * failing write trips disconnect detection. No-op until called.
   */
  reassertWall: () => void;
  /**
   * Restore the climb captured before this device's latest accepted wall report.
   * The platform relights it over BLE first, then reports it to board presence.
   */
  undoWallChange: () => Promise<boolean>;
  /**
   * Re-light an arbitrary board-presence climb (e.g. one the wall kiosk scrubbed
   * back to). Writes the frames over BLE FIRST, then — only if the write is
   * confirmed — reports it to board presence, so a failed/absent write never
   * broadcasts a phantom-live wall. Returns false when this device isn't the
   * driver, presence is disabled, the board is unbound, or the climb has no
   * frames (an empty write would blank the wall). Does not arm the undo toast:
   * a kiosk relight is its own restore model.
   */
  relightPresenceClimb: (climb: BoardPresenceClimb) => Promise<boolean>;
  /**
   * Show the undo affordance for the next accepted wall report only. UI control
   * surfaces call this immediately before a deliberate control-gain action.
   */
  armUndoWallChangeToast: () => void;
  /**
   * Serial to silently reconnect to for the board currently in view, or null
   * when nothing is remembered or the user switched boards — in which case
   * callers open the device picker instead. Aurora boards only.
   */
  reconnectSerialForCurrentBoard: string | null;
  /**
   * BLE device id to silently reconnect to for a MoonBoard currently in view
   * (MoonBoards carry no serial), or null when nothing is remembered or the user
   * switched boards. The lightbulb passes this so the tap reconnects to the same
   * board instead of opening the picker.
   */
  reconnectDeviceIdForCurrentBoard: string | null;
  autoDisconnectEnabled: boolean;
  autoDisconnectTimeoutSeconds: number;
  autoDisconnectWarning: boolean;
  /**
   * The active board is flagged as having no LED light kit (`hasLeds === false`).
   * Optional-field contract: a missing/stale flag reads as "has LEDs", so an LED
   * wall can only lose its Bluetooth affordances through an explicit `false`.
   */
  ledless: boolean;
  /**
   * This device holds the wall WITHOUT a Bluetooth link: it drives who is on the
   * wall for everyone watching the board feed, but writes zero bytes. Never true
   * at the same time as a physical link — {@link takeVirtualWall} refuses while
   * connected and an effect releases the hold the moment BLE connects.
   */
  virtualWallHeld: boolean;
  /**
   * The server's single holder slot belongs to a DIFFERENT signed-in user. A
   * virtual hold has no radio to enforce exclusivity the way a BLE link does, so
   * this is the only thing that stops two phones both believing they drive the
   * wall. Anonymous holders carry no userId and can't be compared, so they never
   * set this.
   */
  wallHeldByOtherUser: boolean;
  /**
   * Take the wall with no Bluetooth: report the current climb to the board feed
   * and keep reporting as the queue moves. Refused while a BLE link exists —
   * a real write always wins. Safe to call on a board that still reports
   * `hasLeds: true`; the picker's "this wall has no lights" offer uses exactly
   * that to take the wall for this app run without touching the server flag.
   */
  takeVirtualWall: () => void;
  /** Release a virtual hold and tell the feed the wall is free. No-op when not held. */
  releaseVirtualWall: () => void;
  /** Either transport can put a climb on the wall right now. */
  canDriveWall: boolean;
};

const BluetoothContext = createContext<BluetoothContextValue | null>(null);
const EMPTY_PICKER_DEVICES: [] = [];
// How long a switch-to-config auto-connect request stays armed waiting for the
// switched board's props to reach this provider before it is dropped.
const PENDING_AUTO_CONNECT_TTL_MS = 15_000;
const UNDO_WALL_CHANGE_TOAST_ARM_TTL_MS = 10_000;
// Stand-in for the physical write's latency on a wall with no lights. The
// auto-sender's drain loop only coalesces while a commit is in flight, so
// without a settle window a five-climb swipe would land five reports (and five
// durable board_climb_events rows) instead of the two a BLE write produces.
const VIRTUAL_WALL_SETTLE_MS = 600;

/** Resolves after `ms`, or immediately when the caller's signal aborts. */
function settleVirtualWallWrite(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      // Remove explicitly rather than trusting `{ once: true }`: React Native's
      // AbortSignal is a JS shim, and an ignored option would leak a listener per
      // settle. Removing here is harmless if the option IS honoured.
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timeoutId);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formatPickerBoardConfig(t: TFunction<'settings'>, config: BleBoardConfig): string {
  return t('boardConfigMismatch.mobileConfigValue', {
    board: formatBoardDisplayName(config.boardName),
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds,
  });
}

type PendingWallReport = {
  item: ClimbQueueItem;
  undoTarget: BoardPresenceClimb | null;
  undoToastArmId: number | null;
};

function queueItemReportSignature(item: ClimbQueueItem): string {
  return `${item.climb.uuid}:${item.climb.frames}:${item.climb.angle ?? ''}`;
}

function presenceClimbReportSignature(climb: BoardPresenceClimb | null): string | null {
  if (!climb) return null;
  return `${climb.climbUuid}:${climb.frames ?? ''}:${climb.angle ?? ''}`;
}

/** The `frames::mirror` of the LEDs physically on the wall — what any write path
 *  records so a dedup-path report never confirms a climb the wall isn't showing. */
function physicalFramesSignature(frames: string, mirrored: boolean): string {
  return `${frames}::${mirrored ? 1 : 0}`;
}

function presenceClimbToQueueInput(climb: BoardPresenceClimb): ClimbQueueItemInput {
  return {
    uuid: climb.queueItemUuid ?? `undo:${climb.climbUuid}:${climb.seq}`,
    climb: {
      uuid: climb.climbUuid,
      setter_username: climb.setter ?? '',
      name: climb.name ?? '',
      frames: climb.frames ?? '',
      angle: climb.angle ?? 0,
      ascensionist_count: 0,
      difficulty: climb.grade ?? '',
      quality_average: '',
      stars: 0,
      difficulty_error: '',
    },
  };
}

/**
 * Isolated child component that subscribes to the queue's currentClimbQueueItem
 * and auto-sends climb data over BLE. Only mounted when isConnected is true so
 * the BluetoothProvider itself never subscribes to the climb context, preventing
 * re-renders of the entire component tree on every climb change when BT is
 * disconnected.
 *
 * Uses a latest-wins drain loop for writes:
 * - `isWritingRef` tracks if a write is in progress
 * - `pendingSendRef` stores the most recent pending climb plus colour state
 * - When a new climb or colour state arrives during a write, it replaces the pending send
 * - When the current write completes, the drain loop picks up whatever's pending
 * - Deduplicates byte-identical broadcasts via `lastSentSignatureRef` (keyed on
 *   uuid + frames + mirror + color signature, so a mirror toggle, hold edit, or
 *   colour override change on the same climb re-pushes), and a `reassertNonce`
 *   bump punches through the dedup once.
 */
function BluetoothAutoSender({
  sendFramesToBoard,
  onWallConfirmed,
  reassertNonce,
  connectInitialSendRef,
  lastPhysicalFramesRef,
  colorSignature,
  activeConfig,
  onSkipSpillClimb,
  onUnresolvedCurrentClimb,
}: {
  sendFramesToBoard: SendFramesToBoard;
  /**
   * Fired once a climb is on the wall (a fresh write or a deduped re-broadcast).
   * Receives the full lit queue item so consumers can both emit the local
   * confirm (uuid only) and report the climb to the board-presence channel.
   */
  onWallConfirmed: (item: ClimbQueueItem) => void;
  reassertNonce: number;
  // One-shot seed: what connect() already wrote as initialFrames, so the
  // freshly mounted AutoSender doesn't repeat a byte-identical first send.
  connectInitialSendRef: React.MutableRefObject<{ frames: string; mirrored: boolean; colorSignature: string } | null>;
  // The `frames::mirror` of the LEDs PHYSICALLY on the wall right now, written by
  // ANY path (this auto-sender, an undo, a kiosk relight). The dedup-report branch
  // only confirms a climb whose frames match this — otherwise a relight/undo that
  // changed the wall out from under a byte-identical queue climb would make the
  // dedup path report the queue climb (a phantom, not on the wall).
  lastPhysicalFramesRef: React.MutableRefObject<string | null>;
  colorSignature: string;
  // Active board (name + layout) so a climb set for a different board can be
  // detected and skipped before it dark-fires the wall. Undefined until the board
  // config resolves — then everything classifies as "unknown" (sent as today).
  activeConfig: ActiveBoardForCompatibility | undefined;
  // Called when the current climb is a "spill" (belongs to another board). Hands
  // the provider the next compatible queue item to advance to (or null) plus the
  // skip count, so it can re-point the queue + toast without the AutoSender
  // owning queue actions or i18n.
  onSkipSpillClimb: (args: { skipped: ClimbQueueItem; next: ClimbQueueItem | null; skippedCount: number }) => void;
  // Called when the current climb reached the auto-sender with no renderable
  // frames (a partially-synced peer broadcast, or a FullSync / snapshot restore
  // that landed before the climb hydrated). Lets the provider record the
  // unresolved-current-climb window without the AutoSender owning analytics/board
  // context. Fired once per queue-item uuid.
  onUnresolvedCurrentClimb: (item: ClimbQueueItem) => void;
}) {
  type AutoSendRequest = {
    item: ClimbQueueItem;
    sendFramesToBoard: SendFramesToBoard;
    colorSignature: string;
  };

  const { state } = useQueue();
  const { currentClimbQueueItem } = state;
  const onWallConfirmedRef = useRef(onWallConfirmed);
  useEffect(() => {
    onWallConfirmedRef.current = onWallConfirmed;
  }, [onWallConfirmed]);

  // Live refs so the drain loop reads the latest board config + skip handler +
  // queue without listing them as effect deps (which would re-run the loop on
  // every queue keystroke). A board change re-creates sendFramesToBoard, which
  // IS a dep, so the loop still re-evaluates compatibility when the board flips.
  const activeConfigRef = useRef(activeConfig);
  activeConfigRef.current = activeConfig;
  const onSkipSpillClimbRef = useRef(onSkipSpillClimb);
  useEffect(() => {
    onSkipSpillClimbRef.current = onSkipSpillClimb;
  }, [onSkipSpillClimb]);
  const onUnresolvedCurrentClimbRef = useRef(onUnresolvedCurrentClimb);
  useEffect(() => {
    onUnresolvedCurrentClimbRef.current = onUnresolvedCurrentClimb;
  }, [onUnresolvedCurrentClimb]);
  const queueRef = useRef(state.queue);
  queueRef.current = state.queue;
  // Dedup spill reports: the async drain can re-enter for the same incompatible
  // current before the advance lands (a colour/reassert re-render races the
  // setCurrentClimb). Report a given spill uuid once, then clear the moment a
  // compatible/unknown climb is processed — so deliberately navigating BACK to a
  // skipped spill re-advances and re-toasts instead of silently sticking.
  const lastSkipReportedUuidRef = useRef<string | null>(null);
  // Dedup unresolved-current-climb reports the same way lastSkipReportedUuidRef
  // dedups spills: the async drain can re-enter for the same unresolved current
  // (a colour/reassert re-render races the resolution patch). Report a given uuid
  // once, then clear it the moment a renderable climb is processed — so a later
  // relapse to unresolved (a FullSync re-staled the item) re-reports.
  const lastUnresolvedReportedUuidRef = useRef<string | null>(null);

  const isWritingRef = useRef(false);
  const pendingSendRef = useRef<AutoSendRequest | null>(null);
  // The signature of the last climb actually pushed to the wall: uuid + rendered
  // frames + mirror state + colour override state. Re-broadcasts with the same
  // signature skip the physical write (the board is idempotent, but we'd
  // double-fire haptics); changing any piece re-pushes.
  const lastSentSignatureRef = useRef<string | null>(null);
  // Last `reassertNonce` acted on. When the incoming nonce differs, a one-shot
  // re-push is requested so the current climb re-fires even if unchanged.
  const lastReassertNonceRef = useRef(reassertNonce);
  // Set when a reassert is requested, consumed inside the drain loop. A ref
  // (not just clearing the signature in the effect) so a reassert landing
  // *during* an in-flight write survives: the completing write re-sets the
  // signature, and clearing it again at the top of the next loop iteration is
  // what actually forces the re-push.
  const reassertPendingRef = useRef(false);

  // Single AbortController scoped to the AutoSender's lifetime. Aborted
  // exactly once on unmount so the in-flight drain loop cancels the
  // underlying adapter.write and returns before firing post-send side
  // effects for a climb the user has navigated away from.
  const abortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!currentClimbQueueItem) return;
    const signal = abortControllerRef.current?.signal;
    if (signal?.aborted) return;

    // A reassert request (lightbulb re-take) forces a fresh write of the current
    // climb even when the pixels are byte-identical. Flag it; the drain loop
    // clears the dedup signature when it picks the climb up, which also covers
    // a reassert that lands while a write is already in flight.
    if (reassertNonce !== lastReassertNonceRef.current) {
      lastReassertNonceRef.current = reassertNonce;
      reassertPendingRef.current = true;
    }

    const sendRequest: AutoSendRequest = {
      item: currentClimbQueueItem,
      sendFramesToBoard,
      colorSignature,
    };

    if (isWritingRef.current) {
      pendingSendRef.current = sendRequest;
      return;
    }

    isWritingRef.current = true;

    const drain = async () => {
      let toSend: AutoSendRequest | null = sendRequest;
      try {
        while (toSend) {
          if (signal?.aborted) return;
          const { item, sendFramesToBoard: requestSendFramesToBoard, colorSignature: requestColorSignature } = toSend;

          // Spill guard: a climb set for a DIFFERENT board/layout than the
          // connected board would skip every LED placement and dark-fire the
          // wall (surfacing as the incompatible_climb failure). Don't write it —
          // hand the provider the next compatible queue item to advance to (the
          // queue snapshot + active config live in refs so this stays off the
          // effect deps). Only a KNOWN mismatch is skipped; unknown/missing
          // metadata is sent as today.
          if (classifyClimbBoardCompatibility(activeConfigRef.current, item.climb) === 'incompatible') {
            // The skip handler may clearBoard(), so whatever the dedup ref
            // remembers is no longer on the wall — drop it, or returning to
            // the previously lit climb would hit the byte-identical skip and
            // leave the wall dark while still firing onWallConfirmed. Same for
            // the connect-initial-send seed: consuming it after the clear
            // would set the signature without a write (dark wall again).
            lastSentSignatureRef.current = null;
            connectInitialSendRef.current = null;
            if (lastSkipReportedUuidRef.current !== item.uuid) {
              lastSkipReportedUuidRef.current = item.uuid;
              const { item: nextItem, skippedCount } = findNextCompatibleQueueItem(
                queueRef.current,
                item.uuid,
                activeConfigRef.current,
              );
              onSkipSpillClimbRef.current({ skipped: item, next: nextItem, skippedCount });
            }
            toSend = pendingSendRef.current;
            pendingSendRef.current = null;
            continue;
          }
          // Reaching here means the item is compatible/unknown and will be sent —
          // clear the spill dedup so a later return to a skipped spill re-reports.
          lastSkipReportedUuidRef.current = null;

          // Resolution guard: a partially-synced climb (a party peer broadcast,
          // or a server FullSync / snapshot restore that landed before the climb
          // hydrated) can become the current climb with empty frames. Empty
          // frames is the board's "clear all LEDs" command, so auto-sending it
          // would dark-fire the wall and silently buzz success (the exact #3850
          // report: pick a climb → wall goes dark). Hold the write until the
          // frames arrive — the board keeps the previous climb lit, and this
          // effect re-runs on the resolved item (new identity, real frames) to
          // light it. Report once per uuid so the window is visible in analytics.
          if (!hasRenderableFrames(item.climb)) {
            if (lastUnresolvedReportedUuidRef.current !== item.uuid) {
              lastUnresolvedReportedUuidRef.current = item.uuid;
              onUnresolvedCurrentClimbRef.current(item);
            }
            toSend = pendingSendRef.current;
            pendingSendRef.current = null;
            continue;
          }
          lastUnresolvedReportedUuidRef.current = null;

          // connect() may have just written these exact frames as its
          // initialFrames (connect-and-light flows like the play drawer).
          // Seed the dedup signature so this freshly mounted AutoSender
          // doesn't immediately repeat the byte-identical write and
          // double-fire the success haptic. One-shot — and a pending
          // reassert below still wins and forces a re-push.
          const connectSend = connectInitialSendRef.current;
          if (connectSend) {
            connectInitialSendRef.current = null;
            if (
              lastSentSignatureRef.current === null &&
              connectSend.frames === item.climb.frames &&
              connectSend.mirrored === !!item.climb.mirrored &&
              connectSend.colorSignature === requestColorSignature
            ) {
              lastSentSignatureRef.current = `${item.climb.uuid}::${item.climb.frames}::${item.climb.mirrored ? 1 : 0}::${requestColorSignature}`;
              // connect() physically wrote these frames, so record them as what's on
              // the wall — else the dedup-confirm below (which now requires the wall
              // to actually show the climb) would suppress the confirm.
              lastPhysicalFramesRef.current = physicalFramesSignature(item.climb.frames, !!item.climb.mirrored);
            }
          }

          // Honour a pending reassert exactly when the climb is picked up —
          // clearing the signature here (rather than in the effect) survives an
          // in-flight write that re-set it on completion.
          if (reassertPendingRef.current) {
            reassertPendingRef.current = false;
            lastSentSignatureRef.current = null;
          }

          // Deduplicate byte-identical re-broadcasts (same climb, frames,
          // mirror, and colours). The board is idempotent so a re-send is
          // functionally fine, but we'd double-fire haptics. A mirror toggle,
          // hold edit, or colour change updates the signature and re-pushes.
          const sendSignature = `${item.climb.uuid}::${item.climb.frames}::${item.climb.mirrored ? 1 : 0}::${requestColorSignature}`;
          if (sendSignature === lastSentSignatureRef.current) {
            // Re-broadcast of the byte-identical climb: skip the physical write —
            // but only CONFIRM it if the wall still physically shows these frames.
            // A relight/undo may have changed the wall out from under us, in which
            // case confirming here would report a climb that isn't lit (a phantom).
            if (physicalFramesSignature(item.climb.frames, !!item.climb.mirrored) === lastPhysicalFramesRef.current) {
              onWallConfirmedRef.current(item);
            }
            toSend = pendingSendRef.current;
            pendingSendRef.current = null;
            continue;
          }

          try {
            const result = await requestSendFramesToBoard(item.climb.frames, !!item.climb.mirrored, signal, {
              sendSource: 'auto',
              targetQueueItemUuid: item.uuid,
              climbUuid: item.climb.uuid,
              climbBoardType: item.climb.boardType,
              climbLayoutId: item.climb.layoutId,
            });

            // After the await, the AutoSender may have unmounted — skip
            // post-send side effects.
            if (signal?.aborted) return;

            if (result === true) {
              lastSentSignatureRef.current = sendSignature;
              lastPhysicalFramesRef.current = physicalFramesSignature(item.climb.frames, !!item.climb.mirrored);
              onWallConfirmedRef.current(item);
              hapticSuccess();
            }
          } catch (error) {
            if (signal?.aborted) return;
            console.error('Error sending climb to board:', error);
            // Distinct from the manual lightbulb send (`ble-send`) so PostHog can
            // tell auto-sender failures (climb-change drain loop) apart.
            reportHandledError(error, { tags: { source: 'ble-auto-send' } });
          }

          toSend = pendingSendRef.current;
          pendingSendRef.current = null;
        }
      } finally {
        isWritingRef.current = false;
      }
    };

    void drain();
  }, [currentClimbQueueItem, sendFramesToBoard, reassertNonce, colorSignature]);

  return null;
}

/**
 * Reconciles a virtual hold with the server's holder slot.
 *
 * A BLE link is exclusive because the radio says so — one phone is connected to
 * an Aurora box at a time. A hold with no radio has nothing enforcing that, and
 * the server keeps a single last-write-wins holder slot, so without this two
 * climbers at the same wall would both show a lit control and both keep
 * reporting. The comparison is board-scoped and deliberately NOT session-gated:
 * production shows 413 boards with several climbers reporting versus 36 boards
 * with any party-session row at all, so a session gate would miss the case this
 * feature exists for.
 *
 * On a wall with no light kit it also carries the peer signal for a BYSTANDER
 * who never took the wall: `deriveBoardConnection` only reports a holder who is
 * a member of your party session, and the observed sharing pattern here is same
 * board, no session.
 *
 * Mounted only on a ledless board, or while the wall is held virtually, which
 * keeps the profile read (and the holder subscription's re-renders) entirely off
 * the ordinary Bluetooth path. Anonymous holders carry no userId and cannot be
 * compared — accepted, not guessed at.
 */
function VirtualWallHolderWatch({ onHeldByOtherUserChange }: { onHeldByOtherUserChange: (held: boolean) => void }) {
  const { holder } = useBoardPresenceCurrent();
  // Same `['profile']` query key every other profile reader uses, so this is a
  // React Query cache read, not another request. Declared inline rather than
  // through the `lib/graphql/hooks` barrel on purpose: the barrel would join the
  // Bluetooth provider's module graph for a value only this mount-gated child
  // ever needs.
  const { data: viewerProfile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => getHttpClient().request<GetProfileQueryResponse>(GET_PROFILE),
    select: (response: GetProfileQueryResponse) => response.profile,
    // The viewer's own id does not change within a session, and this component
    // mounts every time someone takes the wall. Without this the default
    // staleTime of 0 would fire a background refetch on each of those mounts.
    staleTime: Infinity,
  });
  const holderUserId = holder?.userId ?? null;
  const viewerUserId = viewerProfile?.id ?? null;
  const heldByOtherUser = holderUserId !== null && viewerUserId !== null && holderUserId !== viewerUserId;
  const onHeldByOtherUserChangeRef = useRef(onHeldByOtherUserChange);
  onHeldByOtherUserChangeRef.current = onHeldByOtherUserChange;
  useEffect(() => {
    onHeldByOtherUserChangeRef.current(heldByOtherUser);
  }, [heldByOtherUser]);
  // Unmount-only, so a board that stops being watched doesn't strand a stale
  // "a peer holds it". Separate from the effect above: sharing one cleanup
  // would churn the value false on every holder change.
  useEffect(() => () => onHeldByOtherUserChangeRef.current(false), []);
  return null;
}

type BluetoothProviderProps = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  boardUuid?: string;
  /**
   * Whether the active board has an LED light kit. Optional on purpose — see the
   * `ledless` note on BluetoothContextValue. Only an explicit `false` changes
   * behaviour.
   */
  hasLeds?: boolean;
  children: React.ReactNode;
};

export function BluetoothProvider({
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardUuid,
  hasLeds,
  children,
}: BluetoothProviderProps) {
  const ledless = hasLeds === false;
  // A hold with no radio behind it. Kept OUT of `isConnected` so the Live
  // Activity, the lock-screen Prev/Next and both native iOS intents keep seeing
  // the BLE-only value they see today (no Swift change).
  const [virtualWallHeld, setVirtualWallHeld] = useState(false);
  const virtualWallHeldRef = useRef(false);
  virtualWallHeldRef.current = virtualWallHeld;
  const [writeActivityStore] = useState(createBleWriteActivityStore);
  const { sessionId, confirmClimbOnWall, reportWallDisconnect, setSessionBoardSerial, lastConnectedBoardSerial } =
    useQueueSessionControls();
  const { t } = useTranslation('settings');
  const { t: tSession } = useTranslation('session');
  // Board presence ("now on the wall"). Always-on now (the board-presence flag
  // was removed). `enabled` is true while the provider is mounted and false only
  // for the outside-provider DISABLED_CONTROLS fallback, where `boardId` is null
  // and the shared wall context's report/undo no-op — so a pre-provider render
  // still behaves safely.
  const {
    enabled: presenceEnabled,
    boardId: presenceBoardId,
    resolveAndBindBoard,
    resolveAndBindBoardByConfig,
    reportClimbForBoard,
    reportDisconnectForBoard,
    restampBoardMembershipByUuid,
  } = useBoardPresenceControls();
  const { currentClimb: wallCurrentClimb } = useBoardPresenceCurrent();
  // Set by VirtualWallHolderWatch, which mounts only on a wall with no light kit
  // or while this device holds one virtually — so the profile read it needs never
  // runs on the ordinary Bluetooth path.
  const [wallHeldByOtherUser, setWallHeldByOtherUser] = useState(false);
  const { showUndoWallChangeSnackbar } = useQueueSnackbar();
  // Queue actions (no state subscription, so the provider doesn't re-render on
  // queue changes) + toast, for advancing past a spill climb and telling the user.
  const { setCurrentClimb } = useQueueActions();
  const { showToast } = useToast();
  const [autoDisconnectBle] = useSetting('autoDisconnectBle');
  const [autoDisconnectTimeoutSeconds] = useSetting('autoDisconnectTimeoutSeconds');
  const [autoDisconnectWarning, setAutoDisconnectWarning] = useState(false);
  const autoDisconnectExpireRef = useRef<() => void>(() => {});
  const autoDisconnectControllerRef = useRef<AutoDisconnectController | null>(null);
  if (!autoDisconnectControllerRef.current) {
    autoDisconnectControllerRef.current = new AutoDisconnectController({
      onExpire: () => autoDisconnectExpireRef.current(),
    });
  }
  const resetAutoDisconnect = useCallback(() => {
    autoDisconnectControllerRef.current?.reset();
    setAutoDisconnectWarning(false);
  }, []);
  const { overrides: holdColorOverrides, signature: holdColorSignature } = useHoldColorOverrides();
  const bluetoothColorOverrides = useMemo(
    () => getBluetoothColorOverrides(holdColorOverrides),
    // Marker-only accessibility edits must not churn the BLE sender.
    // The color signature is the complete BLE-visible override identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdColorSignature],
  );

  // Mirror the rendered board config for identity-stable send/skip analytics.
  // Connection resolution uses BleConnectionHandle.config instead (the exact
  // adapter-generation snapshot), never these mutable route refs.
  const boardNameRef = useRef(boardName);
  boardNameRef.current = boardName;
  const layoutIdRef = useRef(layoutId);
  layoutIdRef.current = layoutId;
  const sizeIdRef = useRef(sizeId);
  sizeIdRef.current = sizeId;
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const lastConnectedBoardSerialRef = useRef(lastConnectedBoardSerial);
  useEffect(() => {
    lastConnectedBoardSerialRef.current = lastConnectedBoardSerial;
  }, [lastConnectedBoardSerial]);
  // Mirror reportWallDisconnect into a ref so the empty-dep releaseBoardHolder
  // callback can fire the session-scoped "wall went dark" broadcast on a BLE
  // drop without churning its identity.
  const reportWallDisconnectRef = useRef(reportWallDisconnect);
  reportWallDisconnectRef.current = reportWallDisconnect;

  // Live refs so handleWallConfirmed stays identity-stable while still reading
  // the latest flag/board/report fn (it's mirrored into the AutoSender via a ref).
  const presenceEnabledRef = useRef(presenceEnabled);
  presenceEnabledRef.current = presenceEnabled;
  const presenceBoardIdRef = useRef(presenceBoardId);
  presenceBoardIdRef.current = presenceBoardId;
  const reportClimbForBoardRef = useRef(reportClimbForBoard);
  reportClimbForBoardRef.current = reportClimbForBoard;
  const reportDisconnectForBoardRef = useRef(reportDisconnectForBoard);
  reportDisconnectForBoardRef.current = reportDisconnectForBoard;
  const restampBoardMembershipByUuidRef = useRef(restampBoardMembershipByUuid);
  restampBoardMembershipByUuidRef.current = restampBoardMembershipByUuid;
  const boardUuidRef = useRef(boardUuid);
  boardUuidRef.current = boardUuid;
  // One membership re-stamp per report signature. An anonymous emitter is keyed
  // `conn:{connectionId}` and loses membership on every socket reconnect, so the
  // first rejection is worth one retry — a second would just hammer.
  const restampedReportSignatureRef = useRef<string | null>(null);
  const wallCurrentClimbRef = useRef<BoardPresenceClimb | null>(wallCurrentClimb);
  wallCurrentClimbRef.current = wallCurrentClimb;
  const showUndoWallChangeSnackbarRef = useRef(showUndoWallChangeSnackbar);
  showUndoWallChangeSnackbarRef.current = showUndoWallChangeSnackbar;
  // Last accepted report signature. Set only after the server accepts a report,
  // and only used to skip a byte-identical local re-broadcast while the feed
  // still shows that same signature.
  const lastAcceptedReportSignatureRef = useRef<string | null>(null);
  const lastAcceptedWallSignatureRef = useRef<string | null>(null);
  // The `frames::mirror` of the LEDs physically on the wall, updated by every
  // write path (auto-sender, undo, kiosk relight). Shared with the AutoSender so
  // its dedup-report branch never confirms a queue climb the wall isn't showing.
  const lastPhysicalFramesRef = useRef<string | null>(null);
  const pendingReportSignatureRef = useRef<string | null>(null);
  const pendingWallReportRef = useRef<PendingWallReport | null>(null);
  const pendingPresenceResolveRef = useRef(false);
  const pendingPresenceResolveConnectionRef = useRef<BleConnectionHandle | null>(null);
  const resolvedPresenceBoardIdRef = useRef<number | null>(presenceBoardId);
  const undoWallChangeTargetRef = useRef<BoardPresenceClimb | null>(null);
  const previousPresenceBoardIdRef = useRef<number | null>(presenceBoardId);
  const boardConfigIdentity = `${boardName ?? ''}:${layoutId ?? ''}:${sizeId ?? ''}:${setIds ?? ''}`;
  const previousBoardConfigIdentityRef = useRef(boardConfigIdentity);
  // True while this connection was made via "Connect anyway" on the board-config
  // mismatch dialog (our records say this controller belongs to another setup).
  // Cleared on disconnect/drop and on board-config change. Attached to connection
  // + send analytics so override sessions are filterable.
  const connectedViaMismatchOverrideRef = useRef(false);
  const undoWallChangeToastArmIdRef = useRef<number | null>(null);
  const nextUndoWallChangeToastArmIdRef = useRef(0);
  const undoWallChangeToastArmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUndoWallChangeToastArm = useCallback(() => {
    undoWallChangeToastArmIdRef.current = null;
    if (undoWallChangeToastArmTimeoutRef.current) {
      clearTimeout(undoWallChangeToastArmTimeoutRef.current);
      undoWallChangeToastArmTimeoutRef.current = null;
    }
  }, []);

  const armUndoWallChangeToast = useCallback(() => {
    clearUndoWallChangeToastArm();
    const armId = nextUndoWallChangeToastArmIdRef.current + 1;
    nextUndoWallChangeToastArmIdRef.current = armId;
    undoWallChangeToastArmIdRef.current = armId;
    undoWallChangeToastArmTimeoutRef.current = setTimeout(() => {
      undoWallChangeToastArmIdRef.current = null;
      undoWallChangeToastArmTimeoutRef.current = null;
    }, UNDO_WALL_CHANGE_TOAST_ARM_TTL_MS);
  }, [clearUndoWallChangeToastArm]);

  const getUndoWallChangeToastArmId = useCallback(() => undoWallChangeToastArmIdRef.current, []);

  const consumeUndoWallChangeToastArm = useCallback(
    (armId: number | null) => {
      if (armId === null || undoWallChangeToastArmIdRef.current !== armId) {
        return false;
      }
      clearUndoWallChangeToastArm();
      return true;
    },
    [clearUndoWallChangeToastArm],
  );

  const clearPendingWallReportAndUndoToastArm = useCallback(() => {
    pendingWallReportRef.current = null;
    clearUndoWallChangeToastArm();
  }, [clearUndoWallChangeToastArm]);

  // Cleanup-only effect: drop any one-shot arm timer when the provider unmounts.
  useEffect(() => clearUndoWallChangeToastArm, [clearUndoWallChangeToastArm]);

  useEffect(() => {
    const previousBoardConfigIdentity = previousBoardConfigIdentityRef.current;
    previousBoardConfigIdentityRef.current = boardConfigIdentity;
    if (previousBoardConfigIdentity !== boardConfigIdentity) {
      clearPendingWallReportAndUndoToastArm();
      connectedViaMismatchOverrideRef.current = false;
    }
  }, [boardConfigIdentity, clearPendingWallReportAndUndoToastArm]);

  useEffect(() => {
    if (presenceBoardId !== null) {
      resolvedPresenceBoardIdRef.current = presenceBoardId;
    } else if (!pendingPresenceResolveRef.current) {
      resolvedPresenceBoardIdRef.current = null;
    }
  }, [presenceBoardId]);

  useEffect(() => {
    const currentWallSignature = presenceClimbReportSignature(wallCurrentClimb);
    if (
      lastAcceptedReportSignatureRef.current !== null &&
      currentWallSignature !== null &&
      currentWallSignature !== lastAcceptedReportSignatureRef.current &&
      currentWallSignature !== lastAcceptedWallSignatureRef.current
    ) {
      lastAcceptedReportSignatureRef.current = null;
      lastAcceptedWallSignatureRef.current = null;
    }
  }, [wallCurrentClimb]);

  useEffect(() => {
    const previousBoardId = previousPresenceBoardIdRef.current;
    previousPresenceBoardIdRef.current = presenceBoardId;
    if (previousBoardId === presenceBoardId) {
      return;
    }
    if (previousBoardId !== null || presenceBoardId === null) {
      lastAcceptedReportSignatureRef.current = null;
      lastAcceptedWallSignatureRef.current = null;
      pendingReportSignatureRef.current = null;
      // The one-shot re-stamp marker is per board: two boards can in principle
      // produce the same report signature, and the second must still get its
      // one membership retry.
      restampedReportSignatureRef.current = null;
      undoWallChangeTargetRef.current = null;
      clearPendingWallReportAndUndoToastArm();
    }
  }, [clearPendingWallReportAndUndoToastArm, presenceBoardId]);

  const reportWallClimb = useCallback(
    async (
      item: ClimbQueueItem,
      boardId: number,
      undoTarget: BoardPresenceClimb | null,
      undoToastArmId: number | null,
    ) => {
      const reportSignature = queueItemReportSignature(item);
      if (lastAcceptedReportSignatureRef.current === reportSignature) {
        const currentWallSignature = presenceClimbReportSignature(wallCurrentClimbRef.current);
        if (
          currentWallSignature === null ||
          currentWallSignature === reportSignature ||
          currentWallSignature === lastAcceptedWallSignatureRef.current
        ) {
          consumeUndoWallChangeToastArm(undoToastArmId);
          return true;
        }
        lastAcceptedReportSignatureRef.current = null;
        lastAcceptedWallSignatureRef.current = null;
      }
      if (pendingReportSignatureRef.current === reportSignature) {
        return true;
      }

      const climbInput = { uuid: item.uuid, climb: toClimbInput(item.climb) };
      const angle = item.climb.angle ?? null;
      const sendReport = () =>
        reportClimbForBoardRef.current(boardId, climbInput, angle).catch((error: unknown) => {
          console.warn('[board-presence] reportBoardClimb failed', error);
          return false;
        });

      pendingReportSignatureRef.current = reportSignature;
      let accepted = await sendReport();
      // The backend rejects a report from a client whose board membership has
      // lapsed. Under BLE that never showed, because every reconnect re-resolved
      // the board; a wall held with no radio has no such event. Re-stamp
      // membership once (without disturbing the live binding) and retry.
      const currentBoardUuid = boardUuidRef.current;
      if (!accepted && currentBoardUuid && restampedReportSignatureRef.current !== reportSignature) {
        restampedReportSignatureRef.current = reportSignature;
        const stillTheSameBoard = await restampBoardMembershipByUuidRef
          .current({ boardUuid: currentBoardUuid })
          .catch(() => false);
        if (stillTheSameBoard) accepted = await sendReport();
      }
      if (pendingReportSignatureRef.current === reportSignature) {
        pendingReportSignatureRef.current = null;
      }

      if (!accepted) {
        lastAcceptedReportSignatureRef.current = null;
        return false;
      }

      lastAcceptedReportSignatureRef.current = reportSignature;
      lastAcceptedWallSignatureRef.current = presenceClimbReportSignature(wallCurrentClimbRef.current);
      undoWallChangeTargetRef.current = undoTarget;
      const showUndoToast = consumeUndoWallChangeToastArm(undoToastArmId);
      if (showUndoToast && undoTarget?.frames) {
        showUndoWallChangeSnackbarRef.current();
      }
      return true;
    },
    [consumeUndoWallChangeToastArm],
  );

  const replayPendingWallReport = useCallback(
    (boardId: number) => {
      const pendingReport = pendingWallReportRef.current;
      if (!pendingReport) return;
      pendingWallReportRef.current = null;
      void reportWallClimb(pendingReport.item, boardId, pendingReport.undoTarget, pendingReport.undoToastArmId);
    },
    [reportWallClimb],
  );

  const handleWallConfirmed = useCallback(
    (item: ClimbQueueItem) => {
      emitWallConfirm(item.climb.uuid);
      if (sessionIdRef.current) {
        void confirmClimbOnWall(item.climb.uuid);
      }
      // Report the lit climb to the board-presence channel regardless of
      // session. Dedup is feed/signature-aware and only arms after an accepted
      // report, so failed reports and two-phone relights can retry.
      if (!presenceEnabledRef.current) return;
      const boardId = pendingPresenceResolveRef.current
        ? null
        : (presenceBoardIdRef.current ?? resolvedPresenceBoardIdRef.current);
      const undoTarget = wallCurrentClimbRef.current;
      const undoToastArmId = getUndoWallChangeToastArmId();
      if (boardId === null) {
        if (pendingPresenceResolveRef.current) {
          pendingWallReportRef.current = { item, undoTarget, undoToastArmId };
        } else {
          consumeUndoWallChangeToastArm(undoToastArmId);
        }
        return;
      }
      void reportWallClimb(item, boardId, undoTarget, undoToastArmId);
    },
    [confirmClimbOnWall, consumeUndoWallChangeToastArm, getUndoWallChangeToastArmId, reportWallClimb],
  );

  const handleConnectSuccess = useCallback(
    (serial: string | null, connection: BleConnectionHandle) => {
      lastAcceptedReportSignatureRef.current = null;
      lastAcceptedWallSignatureRef.current = null;
      pendingReportSignatureRef.current = null;
      pendingWallReportRef.current = null;
      undoWallChangeTargetRef.current = null;
      resolvedPresenceBoardIdRef.current = null;

      // Resolver arguments come from the immutable adapter-generation snapshot,
      // never mutable route refs. A route/config change can render while a
      // connect is completing; its board identity must not be assigned to the
      // older physical link.
      const { boardName: boardType, layoutId, sizeId, setIds: connectionSetIds } = connection.config;
      const setIds = connectionSetIds ?? '';

      // Resolve+bind the shared board so the wall feed subscribes. Aurora uses
      // its controller serial; serial-less boards use the per-config fallback
      // when the backend supports it. An unchanged binding returns its cached
      // identity instead of resolving over the network, because every new BLE
      // generation still needs to attach that board ID for holder release.
      // This is independent of party sessions.
      if (presenceEnabledRef.current && boardType && layoutId != null && layoutId > 0 && sizeId != null && sizeId > 0) {
        pendingPresenceResolveRef.current = true;
        pendingPresenceResolveConnectionRef.current = connection;
        const resolvePromise =
          serial && serial.length > 0
            ? resolveAndBindBoard({ serial, boardType, layoutId, sizeId, setIds })
            : resolveAndBindBoardByConfig({ boardType, layoutId, sizeId, setIds });
        void resolvePromise
          .then((resolved) => {
            if (!resolved) return;
            // The resolver belongs to the generation that initiated it. An old
            // controller can resolve after a replacement connection with the
            // same layout/size; its guarded handle rejects the stale ID without
            // occupying the new generation's still-empty attribution slot.
            if (!connection.setAnalyticsBoardId(resolved.boardId)) return;
            resolvedPresenceBoardIdRef.current = resolved.boardId;
            // Consume the pending-resolve marker BEFORE replaying: a wall
            // confirm landing in the microtask gap between this .then and the
            // .finally below would otherwise still read "resolving", queue a
            // report after the replay already ran, and orphan it forever. The
            // .finally stays for the null/failure paths (same idempotent guard).
            if (pendingPresenceResolveConnectionRef.current === connection) {
              pendingPresenceResolveConnectionRef.current = null;
              pendingPresenceResolveRef.current = false;
            }
            replayPendingWallReport(resolved.boardId);
          })
          .catch((error: unknown) => {
            console.warn('[board-presence] board resolve failed', error);
          })
          .finally(() => {
            if (pendingPresenceResolveConnectionRef.current === connection) {
              pendingPresenceResolveConnectionRef.current = null;
              pendingPresenceResolveRef.current = false;
            }
          });
      }

      if (!serial || !sessionIdRef.current) return;
      const previousSerial = lastConnectedBoardSerialRef.current;
      if (previousSerial === serial) return;
      lastConnectedBoardSerialRef.current = serial;
      void setSessionBoardSerial(serial);
      track('Session Board Serial Set', {
        mode: 'party',
        previousSerialKnown: previousSerial != null,
        boardLayout: boardType,
        boardId: resolvedPresenceBoardIdRef.current ?? presenceBoardIdRef.current ?? undefined,
      });
    },
    [setSessionBoardSerial, resolveAndBindBoard, resolveAndBindBoardByConfig, replayPendingWallReport],
  );

  // Hold placements for the active board, required by the hook's
  // mirrored-frames conversion (hold id → mirroredHoldId). Without this every
  // `mirrored: true` send silently wrote the unmirrored frames to the wall.
  // getBoardRenderData is pure + memoised by board-config key, so this is a
  // cache lookup on re-render.
  const holdsData = useMemo(() => {
    if (!boardName || layoutId === undefined || sizeId === undefined || !setIds) return undefined;
    const parsedSetIds = setIds
      .split(',')
      .map((setId) => Number(setId.trim()))
      // `Number('')` is 0, so a trailing comma would smuggle a bogus set ID 0
      // into the render-data lookup — real set IDs are positive. Keep in
      // lockstep with DeviceCard's parseSetIds.
      .filter((setId) => Number.isInteger(setId) && setId > 0);
    if (parsedSetIds.length === 0) return undefined;
    return (
      getBoardRenderData({ boardName: boardName as BoardName, layoutId, sizeId, setIds: parsedSetIds })?.holdsData ??
      undefined
    );
  }, [boardName, layoutId, sizeId, setIds]);

  // Stable reader for the override flag, so the hook can attach it to connection
  // and send analytics without re-creating its callbacks when the flag flips.
  const getConnectedViaMismatchOverride = useCallback(() => connectedViaMismatchOverrideRef.current, []);

  // The BLE hook owns the physical adapter lifetime and hands us the attribution
  // captured when that exact generation opened. Release and analytics must use
  // that snapshot: the provider may already be rendering a different route by
  // the time a config-switch teardown completes.
  const handleBluetoothConnectionEnded = useCallback(
    (connection: BleConnectionEnded) => {
      clearPendingWallReportAndUndoToastArm();
      connectedViaMismatchOverrideRef.current = false;

      // reportWallDisconnect targets the queue provider's CURRENT session and
      // is a no-op in solo. Calling it unconditionally avoids skipping cleanup
      // when a connection opened solo and later joined, and avoids pretending
      // the snapshotted analytics boolean identifies a mutable session.
      void reportWallDisconnectRef.current();
      if (connection.boardId !== undefined) {
        void reportDisconnectForBoardRef.current(connection.boardId);
      }

      const commonProperties = {
        boardName: connection.boardName,
        layoutId: connection.layoutId,
        sizeId: connection.sizeId,
        setIds: connection.setIds,
        boardId: connection.boardId,
        reason: connection.reason,
        disconnectTrigger: connection.disconnectTrigger,
        inSession: connection.inSession,
        connectionDurationSec: connection.connectionDurationSec,
      };

      if (connection.reason === 'unexpected') {
        const disconnectInfo = connection.disconnectInfo;
        track(SHARED_EVENTS.BluetoothDisconnected, {
          ...commonProperties,
          disconnectSource: disconnectInfo?.source,
          disconnectReason: disconnectInfo?.description,
          disconnectContext: disconnectInfo?.context,
          disconnectIosCode: disconnectInfo?.iosErrorCode,
          disconnectAndroidCode: disconnectInfo?.androidErrorCode,
          disconnectBleCode: disconnectInfo?.bleErrorCode,
          disconnectErrorDomain: disconnectInfo?.errorDomain,
          disconnectCategory: classifyBleDisconnect(disconnectInfo),
        });
        return;
      }

      track(SHARED_EVENTS.BluetoothDisconnected, commonProperties);
    },
    [clearPendingWallReportAndUndoToastArm],
  );

  const {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    pickerState,
    reconnectSerialForCurrentBoard,
    reconnectDeviceIdForCurrentBoard,
    connectInitialSendRef,
  } = useBoardBluetooth({
    boardName,
    layoutId,
    sizeId,
    setIds,
    boardUuid,
    holdsData,
    analyticsBoardId: presenceBoardId,
    analyticsInSession: sessionId != null,
    ledColorOverrides: bluetoothColorOverrides,
    onConnectSuccess: handleConnectSuccess,
    onConnectionEnded: handleBluetoothConnectionEnded,
    getConnectedViaMismatchOverride,
    writeActivityStore,
  });

  // Every successful board write is activity for the auto-disconnect deadline,
  // no matter which surface wrote (queue auto-sender, mirror toggle, playback
  // scrub, climb-edit preview, clear lights). Wrapping the sender here keeps
  // all consumers covered without each one remembering to notify.
  const sendFramesToBoardWithActivityReset = useCallback<SendFramesToBoard>(
    (frames, mirrored, signal, sendContext) => {
      // Pass the hook's promise through untouched (no extra await hop in the
      // send path); the timer reset rides a side chain that only observes
      // success. Callers keep owning failure handling on the returned promise.
      const sendPromise = sendFramesToBoard(frames, mirrored, signal, sendContext);
      sendPromise
        .then((writeSucceeded) => {
          if (writeSucceeded === true) resetAutoDisconnect();
        })
        .catch(() => {});
      return sendPromise;
    },
    [sendFramesToBoard, resetAutoDisconnect],
  );

  /**
   * The single commit seam for "put this climb on the wall". Two backends, one
   * pipeline: everything downstream of a `true` — the latest-wins coalescing
   * drain, the spill guard, `handleWallConfirmed`'s emitWallConfirm /
   * confirmClimbOnWall / report fan-out, the re-take dedup, the undo target —
   * is the existing BLE code, reused verbatim.
   *
   * **Order is load-bearing (BLE first).** `takeVirtualWall` refuses while
   * connected and an effect releases the hold when BLE connects, but that effect
   * runs after the commit that raced it. Testing `isConnected` first means a
   * physical link ALWAYS writes real bytes: the virtual branch is unreachable
   * while a radio is attached, no matter how the two flags interleave.
   */
  const commitWallFrames = useCallback<SendFramesToBoard>(
    (frames, mirrored, signal, sendContext) => {
      if (isConnected) return sendFramesToBoardWithActivityReset(frames, mirrored, signal, sendContext);
      // A wall with no lights: nothing to write. Wait out a stand-in for the
      // write latency so the drain loop coalesces a fast swipe the same way a
      // physical write does, then report the climb as up.
      if (virtualWallHeldRef.current) return settleVirtualWallWrite(VIRTUAL_WALL_SETTLE_MS, signal);
      return Promise.resolve(false);
    },
    [isConnected, sendFramesToBoardWithActivityReset],
  );

  /**
   * Take the wall with no Bluetooth. Deliberately guarded on `!isConnected`
   * ALONE, not on `ledless`: the device picker offers this after a scan that
   * found nothing, on a board whose server flag still says it has LEDs (an empty
   * scan is weak evidence — the box may be off, out of range, or hitting the
   * Android RN 0.86 scan regression), and that offer has to work. Which
   * affordances a board shows is what `ledless` decides; who may take the wall
   * is decided here.
   */
  const takeVirtualWall = useCallback(() => {
    if (isConnected || virtualWallHeldRef.current) return;
    // Same reset a fresh BLE connect does, so the climb already on screen is
    // reported rather than deduped away as "already sent".
    lastAcceptedReportSignatureRef.current = null;
    lastAcceptedWallSignatureRef.current = null;
    pendingReportSignatureRef.current = null;
    pendingWallReportRef.current = null;
    undoWallChangeTargetRef.current = null;
    lastPhysicalFramesRef.current = null;
    virtualWallHeldRef.current = true;
    setVirtualWallHeld(true);
    hapticLight();
    showToast(tSession('mobile.boardPresence.wallTakenToast'), 'success');
    track(SHARED_EVENTS.WallTaken, {
      boardName: boardNameRef.current,
      layoutId: layoutIdRef.current,
      sizeId: sizeIdRef.current,
      ledless,
      inSession: sessionIdRef.current != null,
      boardId: presenceBoardIdRef.current ?? resolvedPresenceBoardIdRef.current ?? undefined,
    });
  }, [isConnected, ledless, showToast, tSession]);

  /**
   * Give the wall back. Mirrors what a BLE drop does (`handleBluetoothConnectionEnded`):
   * broadcast the session-scoped "wall went dark", release the server's holder
   * slot, and drop the undo target — a phone that no longer drives the wall must
   * stop reporting.
   */
  const releaseVirtualWall = useCallback(
    (reason: 'user' | 'ble_connected' | 'board_changed' | 'taken_by_peer' | 'unmount' = 'user') => {
      if (!virtualWallHeldRef.current) return;
      virtualWallHeldRef.current = false;
      setVirtualWallHeld(false);
      // Deliberately does NOT clear `wallHeldByOtherUser`. On a peer takeover
      // this release IS the consequence of that flag going true, and the watch
      // has no reason to re-fire — clearing it here would tell the climber the
      // wall is free at the exact moment someone else took it. The watch owns
      // that value for as long as it is mounted, and clears it on unmount.
      // Only a deliberate hand-back is announced. An auto-release (BLE took
      // over, the board changed, a peer took the wall) is not something the user
      // did, and a toast for it would read as an error.
      if (reason === 'user') {
        hapticLight();
        showToast(tSession('mobile.boardPresence.wallReleasedToast'), 'info');
      }
      undoWallChangeTargetRef.current = null;
      clearPendingWallReportAndUndoToastArm();
      void reportWallDisconnectRef.current();
      const boardId = presenceBoardIdRef.current ?? resolvedPresenceBoardIdRef.current;
      if (boardId !== null) void reportDisconnectForBoardRef.current(boardId);
      track(SHARED_EVENTS.WallReleased, {
        boardName: boardNameRef.current,
        layoutId: layoutIdRef.current,
        sizeId: sizeIdRef.current,
        ledless,
        reason,
        inSession: sessionIdRef.current != null,
        boardId: boardId ?? undefined,
      });
    },
    [clearPendingWallReportAndUndoToastArm, ledless, showToast, tSession],
  );

  const releaseVirtualWallForUser = useCallback(() => releaseVirtualWall('user'), [releaseVirtualWall]);

  // A real link always wins: drop the virtual hold the moment BLE connects, so
  // the two can never both be driving. (commitWallFrames' BLE-first ordering
  // covers the window before this effect runs.)
  useEffect(() => {
    if (isConnected) releaseVirtualWall('ble_connected');
  }, [isConnected, releaseVirtualWall]);

  // Another signed-in climber took the server's holder slot. With no radio to
  // enforce exclusivity, this is what stops two phones both reporting.
  useEffect(() => {
    if (wallHeldByOtherUser) releaseVirtualWall('taken_by_peer');
  }, [wallHeldByOtherUser, releaseVirtualWall]);

  // Switching boards (or leaving) hands the wall back.
  const releaseVirtualWallRef = useRef(releaseVirtualWall);
  releaseVirtualWallRef.current = releaseVirtualWall;
  useEffect(() => {
    if (!boardUuid) return;
    return () => releaseVirtualWallRef.current('board_changed');
  }, [boardUuid]);
  useEffect(() => () => releaseVirtualWallRef.current('unmount'), []);

  const resolvedPickerBoards = useResolvedBleDeviceBoards(pickerState?.devices ?? EMPTY_PICKER_DEVICES);
  const currentBoardConfig = useMemo(() => {
    if (!boardName || layoutId === undefined || sizeId === undefined || !setIds) return undefined;
    const typedBoardName = toBoardName(boardName);
    if (!typedBoardName) return undefined;
    return {
      boardName: typedBoardName,
      layoutId,
      sizeId,
      setIds,
    };
  }, [boardName, layoutId, sizeId, setIds]);

  // True while a route hosts its own picker (the play route) so the app-root
  // picker below stays suppressed — a root picker would otherwise land behind the
  // modal route, and presenting it forces the route to dismiss.
  const [pickerHostedExternally, setPickerHostedExternally] = useState(false);

  // handlePickerSelect, handleMismatchSwitch and the auto-connect effect all
  // need the latest pickerState / resolvedPickerBoards / currentBoardConfig, but
  // pickerState is a fresh object on every scan-progress push. Listing it in a
  // useCallback dep array would churn the onSelect identity each push and defeat
  // DeviceCard's React.memo. Mirror the volatile inputs into refs and read
  // through them — latest-value semantics are exactly right for a tap handler,
  // so keep these handlers free of stale-closure-sensitive logic.
  const pickerStateRef = useRef(pickerState);
  pickerStateRef.current = pickerState;
  const resolvedPickerBoardsRef = useRef(resolvedPickerBoards);
  resolvedPickerBoardsRef.current = resolvedPickerBoards;
  const currentBoardConfigRef = useRef(currentBoardConfig);
  currentBoardConfigRef.current = currentBoardConfig;

  // Track how often the picker's serial→board resolution actually pays off:
  // keep the tallies fresh while the sheet is open (devices and resolutions
  // both stream in), then flush ONE summary event when it closes — per-device
  // or per-render events would massively overcount repeat advertisements.
  const pickerResolutionStatsRef = useRef<PickerResolutionStats | null>(null);
  // Whether the app held a location permission when this picker session opened.
  // Read once per session (PermissionsAndroid.check never prompts) so a
  // devicesTotal=0 flush can be split into "the OS suppressed the results" vs
  // "nothing was there" — see android-scan-location-gate.ts. null off Android,
  // and also null if the user dismissed the picker before the async check landed
  // (rare; PostHog's auto-captured $os separates that from a genuine iOS null).
  const pickerLocationPermissionRef = useRef<boolean | null>(null);
  // Monotonic id for the open picker session. A `check` that resolves after its
  // own session was flushed must not write into the next session's answer.
  const pickerSessionIdRef = useRef(0);
  useEffect(() => {
    if (pickerState) {
      if (pickerResolutionStatsRef.current === null) {
        const sessionId = pickerSessionIdRef.current + 1;
        pickerSessionIdRef.current = sessionId;
        pickerLocationPermissionRef.current = null;
        void getAndroidLocationPermissionState().then((granted) => {
          if (pickerSessionIdRef.current !== sessionId) return;
          pickerLocationPermissionRef.current = granted;
        });
      }
      pickerResolutionStatsRef.current = summarizePickerResolution(
        pickerState.devices,
        resolvedPickerBoards,
        currentBoardConfig,
      );
      return;
    }
    const finalStats = pickerResolutionStatsRef.current;
    if (!finalStats) return;
    pickerResolutionStatsRef.current = null;
    const androidLocationPermissionGranted = pickerLocationPermissionRef.current;
    // Retire the session id as well as the value, so an in-flight check from the
    // session we are flushing right now can no longer land anywhere.
    pickerSessionIdRef.current += 1;
    pickerLocationPermissionRef.current = null;
    track(SHARED_EVENTS.BlePickerDevicesResolved, {
      ...finalStats,
      boardName,
      androidLocationPermissionGranted,
    });
  }, [pickerState, resolvedPickerBoards, currentBoardConfig, boardName]);

  const setActiveBoard = useSetActiveBoard();

  // One-shot request to silently reconnect to `serial` once the active board
  // config has actually switched to `configKey`. Set by the switch flow, cleared
  // by the effect below the moment it fires the reconnect. A single slot is
  // deliberate (last writer wins): each successful switch cancels the picker
  // that produced it, so a second request can only come from a newer flow whose
  // intent supersedes the first.
  const [pendingAutoConnect, setPendingAutoConnect] = useState<{
    serial: string;
    configKey: string;
    armUndoToast: boolean;
  } | null>(null);

  // The switched config normally propagates within one re-render, so a request
  // still pending after this window means it can no longer complete (e.g. the
  // board switch was reverted before the props arrived). Drop it rather than
  // leave a stale one-shot armed that would fire on a much-later, unrelated
  // switch to the same config.
  //
  // Depend on the configKey rather than the whole `pendingAutoConnect` object so
  // re-arming with the same configKey (a race) doesn't reset the timer and
  // silently extend the TTL. Reading it into a local also keeps the dep array
  // exhaustive — configKey is always a string on a live request (never null
  // while the object is set), so the falsy guard only short-circuits the cleared
  // (null) state.
  const pendingConfigKey = pendingAutoConnect?.configKey;
  useEffect(() => {
    if (!pendingConfigKey) return;
    const expiryTimeoutId = setTimeout(() => setPendingAutoConnect(null), PENDING_AUTO_CONNECT_TTL_MS);
    return () => clearTimeout(expiryTimeoutId);
  }, [pendingConfigKey]);

  useEffect(() => {
    if (!pendingAutoConnect) return;
    // Still on the old config — setActiveBoard's cache write hasn't propagated
    // new board props into this provider yet. Wait for the matching config so we
    // don't auto-connect against the LED placement map we're switching away from.
    if (!boardName || layoutId === undefined || sizeId === undefined) return;
    if (boardConfigKey(boardName, layoutId, sizeId) !== pendingAutoConnect.configKey) return;
    // The old cancelled connect may still be settling. connect() bails while
    // connectInFlightRef is set (which tracks `loading`), so a new connect fired
    // now would be silently swallowed — wait for it to clear first.
    if (loading) return;
    const { serial, armUndoToast } = pendingAutoConnect;
    setPendingAutoConnect(null);
    if (armUndoToast) {
      armUndoWallChangeToast();
    }
    // connect's third param does a silent serial auto-select, falling back to the
    // picker only if that serial never advertises.
    void connect(undefined, undefined, serial);
  }, [pendingAutoConnect, boardName, layoutId, sizeId, loading, armUndoWallChangeToast, connect]);

  const handleMismatchSwitch = useCallback(
    async (decision: Extract<PickerSelectionDecision, { kind: 'mismatch' }>) => {
      const armUndoToastAfterSwitch = undoWallChangeToastArmIdRef.current !== null;
      try {
        let board: UserBoard;
        if (decision.entry.kind === 'saved') {
          board = decision.entry.board;
        } else {
          const { boardUuid: recordedBoardUuid } = decision.entry.config;
          if (!recordedBoardUuid) {
            throw new Error('Recorded board config has no saved board to switch to');
          }
          const response = await getHttpClient().request<GetBoardQueryResponse>(GET_BOARD, {
            boardUuid: recordedBoardUuid,
          });
          if (!response.board) {
            throw new Error(`No board found for uuid ${recordedBoardUuid}`);
          }
          board = response.board;
        }
        await setActiveBoard(board);
        // Only cancel the picker once the switch actually went through: a failed
        // board fetch above leaves the picker open so the user can still pick a
        // device or use Connect anyway. The cancel rejects the old connect's
        // picker promise with the silent user-cancel signature (no "connection
        // failed" alert), which clears `loading` and lets the auto-connect
        // effect fire against the switched config.
        pickerStateRef.current?.handleCancel();
        setPendingAutoConnect({
          serial: decision.serial,
          configKey: boardConfigKey(decision.config.boardName, decision.config.layoutId, decision.config.sizeId),
          armUndoToast: armUndoToastAfterSwitch,
        });
      } catch (error) {
        console.error('Failed to switch to correct board config:', error);
        reportHandledError(error, { tags: { source: 'board-config', op: 'switch' } });
        track(SHARED_EVENTS.BleBoardConfigMismatchResolved, {
          serial: decision.serial,
          currentBoardName: currentBoardConfigRef.current?.boardName,
          currentLayoutId: currentBoardConfigRef.current?.layoutId,
          recordedBoardName: decision.config.boardName,
          recordedLayoutId: decision.config.layoutId,
          recordedEntryKind: decision.entry.kind,
          // Reaching this catch means the switch button was offered (and tapped).
          canSwitch: true,
          action: 'switch_failed',
        });
        Alert.alert(t('boardConfigMismatch.title'), t('boardConfigMismatch.mobileSwitchFailed'));
      }
    },
    [setActiveBoard, t],
  );

  const handlePickerSelect = useCallback(
    (deviceId: string) => {
      const activePickerState = pickerStateRef.current;
      if (!activePickerState) return;
      const activeBoardConfig = currentBoardConfigRef.current;
      const decision = decideBlePickerSelection({
        deviceId,
        devices: activePickerState.devices,
        resolvedBoards: resolvedPickerBoardsRef.current,
        currentBoardConfig: activeBoardConfig,
      });
      if (decision.kind === 'forward') {
        activePickerState.handleSelect(deviceId);
        return;
      }

      const currentLabel = activeBoardConfig
        ? formatPickerBoardConfig(t, activeBoardConfig)
        : t('boardConfigMismatch.mobileUnknownConfig');
      const recordedLabel = formatPickerBoardConfig(t, decision.config);
      const canSwitch =
        decision.entry.kind === 'saved' ||
        (decision.entry.kind === 'recorded' && decision.entry.config.boardUuid != null);

      const mismatchAnalytics = {
        serial: decision.serial,
        currentBoardName: activeBoardConfig?.boardName,
        currentLayoutId: activeBoardConfig?.layoutId,
        recordedBoardName: decision.config.boardName,
        recordedLayoutId: decision.config.layoutId,
        recordedEntryKind: decision.entry.kind,
        canSwitch,
      };
      track(SHARED_EVENTS.BleBoardConfigMismatchShown, mismatchAnalytics);
      const trackResolved = (action: 'cancel' | 'connect_anyway' | 'switch_setup') =>
        track(SHARED_EVENTS.BleBoardConfigMismatchResolved, { ...mismatchAnalytics, action });

      // "Connect anyway" is a warning, not a destructive action — connecting to a
      // working board the user owns isn't dangerous, just possibly mis-mapped.
      const buttons = [
        { text: t('boardConfigMismatch.cancel'), style: 'cancel' as const, onPress: () => trackResolved('cancel') },
        {
          text: t('boardConfigMismatch.mobileConnectAnyway'),
          onPress: () => {
            trackResolved('connect_anyway');
            connectedViaMismatchOverrideRef.current = true;
            activePickerState.handleSelect(deviceId);
          },
        },
        ...(canSwitch
          ? [
              {
                text:
                  decision.entry.kind === 'saved'
                    ? t('boardConfigMismatch.mobileSwitchSetup')
                    : t('boardConfigMismatch.mobileUseRecordedSetup'),
                onPress: () => {
                  trackResolved('switch_setup');
                  void handleMismatchSwitch(decision);
                },
              },
            ]
          : []),
      ];
      Alert.alert(
        t('boardConfigMismatch.title'),
        [
          t('boardConfigMismatch.mobileConnectAnywayWarning'),
          t('boardConfigMismatch.mobileCurrentLabel', { config: currentLabel }),
          t('boardConfigMismatch.mobileRecordedLabel', { config: recordedLabel }),
        ].join('\n\n'),
        buttons,
      );
    },
    [handleMismatchSwitch, t],
  );

  const undoWallChange = useCallback(async (): Promise<boolean> => {
    const undoTarget = undoWallChangeTargetRef.current;
    const boardId = presenceBoardIdRef.current ?? resolvedPresenceBoardIdRef.current;
    const frames = undoTarget?.frames;
    if (!presenceEnabledRef.current || !undoTarget || !frames || boardId === null) {
      return false;
    }

    lastAcceptedReportSignatureRef.current = null;
    const writeSucceeded = await commitWallFrames(frames, false, undefined, {
      sendSource: 'undo',
      climbUuid: undoTarget.climbUuid,
    }).catch((error: unknown) => {
      console.warn('[board-presence] undo BLE resend failed', error);
      return false;
    });
    if (writeSucceeded !== true) {
      return false;
    }
    lastPhysicalFramesRef.current = physicalFramesSignature(frames, false);

    const accepted = await reportClimbForBoardRef
      .current(boardId, presenceClimbToQueueInput(undoTarget), undoTarget.angle ?? null)
      .catch((error: unknown) => {
        console.warn('[board-presence] undo report failed', error);
        return false;
      });
    if (!accepted) {
      return false;
    }

    lastAcceptedReportSignatureRef.current = presenceClimbReportSignature(undoTarget);
    undoWallChangeTargetRef.current = null;
    return true;
  }, [commitWallFrames]);

  // Generalized `undoWallChange`: relight ANY presence climb (the wall kiosk's
  // "Light this" confirm), not just the captured undo target. Same BLE-first-
  // then-report contract, but parameterized and frames-guarded so an empty
  // `frames` (which `sendFramesToBoard('')` treats as clearBoard) can never blank
  // the wall. Deliberately does NOT arm the undo toast.
  const relightPresenceClimb = useCallback(
    async (climb: BoardPresenceClimb): Promise<boolean> => {
      // While a board bind is resolving, the board-id refs still hold the PREVIOUS
      // board — reporting now would land a lit-climb ghost on the old wall's feed
      // (matches `handleWallConfirmed`'s resolve guard).
      const boardId = pendingPresenceResolveRef.current
        ? null
        : (presenceBoardIdRef.current ?? resolvedPresenceBoardIdRef.current);
      const frames = climb.frames;
      if (!presenceEnabledRef.current || !frames || boardId === null) {
        return false;
      }

      lastAcceptedReportSignatureRef.current = null;
      const writeSucceeded = await commitWallFrames(frames, false, undefined, {
        sendSource: 'wall-relight',
        climbUuid: climb.climbUuid,
      }).catch((error: unknown) => {
        console.warn('[board-presence] kiosk relight BLE resend failed', error);
        return false;
      });
      if (writeSucceeded !== true) {
        return false;
      }
      lastPhysicalFramesRef.current = physicalFramesSignature(frames, false);

      const accepted = await reportClimbForBoardRef
        .current(boardId, presenceClimbToQueueInput(climb), climb.angle ?? null)
        .catch((error: unknown) => {
          console.warn('[board-presence] kiosk relight report failed', error);
          return false;
        });
      if (!accepted) {
        return false;
      }

      lastAcceptedReportSignatureRef.current = presenceClimbReportSignature(climb);
      return true;
    },
    [commitWallFrames],
  );

  const clearBoard = useCallback(
    () => sendFramesToBoardWithActivityReset('', false, undefined, { sendSource: 'clear' }),
    [sendFramesToBoardWithActivityReset],
  );

  // Advance the queue past a "spill" climb (one set for a different board/layout
  // than the connected board) instead of dark-firing the wall, and tell the user.
  // The auto-sender detects the mismatch (and dedups repeat reports for the same
  // spill), computes the next compatible item, and calls this once; here we
  // re-point the queue so the auto-sender lights the next climb, or clear the wall
  // when nothing compatible remains.
  const handleSkipSpillClimb = useCallback(
    ({
      skipped,
      next,
      skippedCount,
    }: {
      skipped: ClimbQueueItem;
      next: ClimbQueueItem | null;
      skippedCount: number;
    }) => {
      // The wall is cleared (rather than advanced to a compatible climb) in a
      // party session — never hijack shared state — or when nothing compatible
      // remains. First-class so the silent clear is filterable in analytics; the
      // clear write itself stays untagged (not a user Clear Lights action).
      const clearedBoard = sessionIdRef.current != null || next === null;
      track(SHARED_EVENTS.BleQueueClimbSkipped, {
        boardName: boardNameRef.current,
        layoutId: layoutIdRef.current,
        sizeId: sizeIdRef.current,
        skippedClimbUuid: skipped.climb.uuid,
        skippedClimbBoardType: skipped.climb.boardType,
        skippedClimbLayoutId: skipped.climb.layoutId ?? undefined,
        skippedCount,
        advancedToClimbUuid: next?.climb.uuid ?? null,
        clearedBoard,
        inSession: sessionIdRef.current != null,
      });

      showToast(t('boardConfigMismatch.skippedSpillToast', { count: skippedCount, name: skipped.climb.name }), 'info');

      // Party: never advance — the current climb is shared session state, and a
      // member whose wall can't light it must not hijack the queue for everyone.
      // Just clear this wall so it doesn't keep showing the previous climb.
      // Untagged internal clear (no sendSource): the user didn't press Clear
      // Lights, so this must not count towards Board Lights Cleared.
      if (sessionIdRef.current != null) {
        void sendFramesToBoard('');
        return;
      }
      if (next) {
        setCurrentClimb(next);
      } else {
        void sendFramesToBoard('');
      }
    },
    [setCurrentClimb, showToast, sendFramesToBoard, t],
  );

  // The auto-sender reached the current climb but it has no frames yet — a
  // partially-synced peer broadcast, or a FullSync / snapshot restore that
  // landed before the climb hydrated. It held the write (so the wall isn't
  // dark-fired); record the window so this class of "picked a climb, wall went
  // dark" is diagnosable fleet-wide. Once resolution patches the frames in, the
  // auto-sender's effect re-runs on the new item identity and lights it.
  const handleUnresolvedCurrentClimb = useCallback((item: ClimbQueueItem) => {
    track(SHARED_EVENTS.ClimbSentToBoardSkipped, {
      skipReason: 'unresolved_climb',
      boardName: boardNameRef.current,
      layoutId: layoutIdRef.current,
      sizeId: sizeIdRef.current,
      climbUuid: item.climb.uuid,
      hasName: !!item.climb.name,
      hasBoardType: !!item.climb.boardType,
      hasLayout: item.climb.layoutId != null,
      inSession: sessionIdRef.current != null,
    });
  }, []);

  // Bumped by `reassertWall()` to force the auto-sender to re-push the current
  // climb once, bypassing the byte-identical dedup.
  const [reassertNonce, setReassertNonce] = useState(0);
  const reassertWall = useCallback(() => setReassertNonce((nonce) => nonce + 1), []);

  const disconnectInFlightRef = useRef<Promise<void> | null>(null);

  // Coalesce adapter disconnect calls. The hook consumes and reports the active
  // generation synchronously before awaiting the native adapter teardown.
  // Auto-disconnect reuses the same release path but keeps the remembered
  // board handle (the hook only forgets the board on a 'user' reason).
  const wrappedDisconnect = useCallback(
    async (reason: BluetoothDisconnectReason = 'user') => {
      const disconnectInFlight = disconnectInFlightRef.current;
      if (disconnectInFlight) {
        await disconnectInFlight;
        return;
      }

      clearPendingWallReportAndUndoToastArm();
      connectedViaMismatchOverrideRef.current = false;
      const disconnectOperation = disconnect(reason).catch(() => {
        // The native iOS adapter's disconnect() can reject (e.g. peripheral
        // already torn down). Callers `void` this promise, so an unhandled
        // rejection would surface as error-reporting noise. Connection state is
        // cleared before the await, so the disconnect is effectively done either way —
        // safe to swallow, matching the keep-awake `.catch(() => {})` pattern.
      });
      disconnectInFlightRef.current = disconnectOperation;
      try {
        await disconnectOperation;
      } finally {
        if (disconnectInFlightRef.current === disconnectOperation) {
          disconnectInFlightRef.current = null;
        }
      }
    },
    [clearPendingWallReportAndUndoToastArm, disconnect],
  );

  const autoDisconnectOnExpire = useCallback(() => {
    void wrappedDisconnect('auto_disconnect');
  }, [wrappedDisconnect]);
  autoDisconnectExpireRef.current = autoDisconnectOnExpire;

  useEffect(() => {
    autoDisconnectControllerRef.current?.update(autoDisconnectBle, autoDisconnectTimeoutSeconds);
  }, [autoDisconnectBle, autoDisconnectTimeoutSeconds]);

  useEffect(() => {
    const controller = autoDisconnectControllerRef.current;
    if (isConnected) controller?.connectedNow();
    else controller?.disconnectedNow();
    return () => controller?.disconnectedNow();
  }, [isConnected]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') autoDisconnectControllerRef.current?.resume();
    });
    return () => subscription.remove();
  }, []);

  // The deadline controller owns expiry; this lightweight poll only drives the
  // final-ten-second visual hint. It runs while connected and updates once per
  // second, avoiding a per-frame animation/state subscription in the provider.
  useEffect(() => {
    setAutoDisconnectWarning(false);
    if (!isConnected || !autoDisconnectBle) return;

    const updateWarning = () => {
      const deadlineMs = autoDisconnectControllerRef.current?.getDeadlineMs() ?? null;
      setAutoDisconnectWarning(deadlineMs !== null && deadlineMs - Date.now() <= 10_000);
    };
    updateWarning();
    const interval = setInterval(updateWarning, 1000);
    return () => clearInterval(interval);
  }, [isConnected, autoDisconnectBle, autoDisconnectTimeoutSeconds]);

  // Register with the module-level status store so consumers rendered outside
  // this provider (e.g. the root tab bar, the long-press BLE controls sheet) can
  // observe BT connection state and force a disconnect. Register the instrumented
  // `wrappedDisconnect` so a force-disconnect is still tracked as user-initiated
  // (not mis-tagged as an unexpected drop). The store expects () => void.
  useEffect(() => {
    if (!isConnected) return;
    const release = registerBluetoothConnection(() => {
      void wrappedDisconnect();
    });
    return release;
  }, [isConnected, wrappedDisconnect]);

  const value = useMemo<BluetoothContextValue>(
    () => ({
      isConnected,
      loading,
      connect,
      disconnect: wrappedDisconnect,
      sendFramesToBoard: sendFramesToBoardWithActivityReset,
      clearBoard,
      reassertWall,
      undoWallChange,
      relightPresenceClimb,
      armUndoWallChangeToast,
      reconnectSerialForCurrentBoard,
      reconnectDeviceIdForCurrentBoard,
      autoDisconnectEnabled: autoDisconnectBle,
      autoDisconnectTimeoutSeconds,
      autoDisconnectWarning,
      ledless,
      virtualWallHeld,
      wallHeldByOtherUser,
      takeVirtualWall,
      releaseVirtualWall: releaseVirtualWallForUser,
      canDriveWall: isConnected || virtualWallHeld,
    }),
    [
      isConnected,
      loading,
      connect,
      wrappedDisconnect,
      sendFramesToBoardWithActivityReset,
      clearBoard,
      reassertWall,
      undoWallChange,
      relightPresenceClimb,
      armUndoWallChangeToast,
      reconnectSerialForCurrentBoard,
      reconnectDeviceIdForCurrentBoard,
      autoDisconnectBle,
      autoDisconnectTimeoutSeconds,
      autoDisconnectWarning,
      ledless,
      virtualWallHeld,
      wallHeldByOtherUser,
      takeVirtualWall,
      releaseVirtualWallForUser,
    ],
  );

  // Dedicated picker context (volatile pickerState kept OFF the main bluetooth
  // context) so a route can host its own picker sheet that stacks above the modal
  // route. Only DevicePickerSheetHost consumes this.
  const pickerHostValue = useMemo<BlePickerHostValue>(
    () => ({
      pickerState,
      onSelect: handlePickerSelect,
      currentBoardConfig,
      setHostedExternally: setPickerHostedExternally,
      onNoLeds: takeVirtualWall,
    }),
    [pickerState, handlePickerSelect, currentBoardConfig, takeVirtualWall],
  );

  return (
    <BluetoothContext.Provider value={value}>
      <BluetoothWriteActivityProvider store={writeActivityStore}>
        {/* Holder model: anyone driving the wall writes it (always-take), so the
            auto-sender mounts on either transport — no driver/preview write-gate.
            Aurora is last-connection-wins, so one phone is physically connected;
            a virtual hold is released the moment a real link appears. */}
        {(isConnected || virtualWallHeld) && (
          <BluetoothAutoSender
            sendFramesToBoard={commitWallFrames}
            onWallConfirmed={handleWallConfirmed}
            reassertNonce={reassertNonce}
            connectInitialSendRef={connectInitialSendRef}
            lastPhysicalFramesRef={lastPhysicalFramesRef}
            colorSignature={holdColorSignature}
            activeConfig={currentBoardConfig}
            onSkipSpillClimb={handleSkipSpillClimb}
            onUnresolvedCurrentClimb={handleUnresolvedCurrentClimb}
          />
        )}
        {/* Reconciles a virtual hold with the server's single holder slot, and
            carries the peer signal for a bystander on a wall with no light kit.
            Mounted only where one of those applies, so the profile read it needs
            stays off the ordinary Bluetooth path. */}
        {(virtualWallHeld || ledless) && <VirtualWallHolderWatch onHeldByOtherUserChange={setWallHeldByOtherUser} />}
        <BlePickerHostContext.Provider value={pickerHostValue}>{children}</BlePickerHostContext.Provider>
        {/* App-root picker, for connects off the tab screens / accessory bar.
            Suppressed while a route (the player) hosts its own — see
            DevicePickerSheetHost. */}
        {pickerState && !pickerHostedExternally && (
          <DevicePickerSheet
            devices={pickerState.devices}
            onSelect={handlePickerSelect}
            onDismiss={pickerState.handleCancel}
            isScanning={pickerState.isScanning}
            resolvedBoards={resolvedPickerBoards}
            currentBoardConfig={currentBoardConfig}
            onNoLeds={takeVirtualWall}
          />
        )}
      </BluetoothWriteActivityProvider>
    </BluetoothContext.Provider>
  );
}

export function useBluetoothContext(): BluetoothContextValue {
  const context = useContext(BluetoothContext);
  if (!context) {
    throw new Error('useBluetoothContext must be used within a BluetoothProvider');
  }
  return context;
}

/**
 * Returns the BluetoothContextValue if rendered inside a BluetoothProvider,
 * or null otherwise. Useful for components that may render before a board
 * is selected (and therefore before BluetoothProvider is mounted).
 */
export function useOptionalBluetoothContext(): BluetoothContextValue | null {
  return useContext(BluetoothContext);
}

export { BluetoothContext };
