import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  getAuroraBluetoothPacket,
  parseApiLevel,
  parseBoardTypeFromDeviceName,
  parseSerialNumber,
  type LedColorOverrides,
} from '@boardsesh/ble-protocol/aurora';
import { getMoonboardBluetoothPacket, isMoonboardDeviceName } from '@boardsesh/ble-protocol/moonboard';
import {
  getWoodsBluetoothPacket,
  isWoodsDeviceName,
  WoodsMultiFrameError,
  type WoodsBoardSize,
  type WoodsPacketResult,
} from '@boardsesh/ble-protocol/woods';
import { getBoardCapabilities, getMoonBoardGeometryByLayoutId, woodsSizeIdToDimension } from '@boardsesh/board-config';
import {
  blePlxErrorCodes,
  classifyBleFailure,
  classifyBleFailureReason,
  isDisconnectionError,
  type BleFailureCategory,
} from '@boardsesh/ble-protocol/connection-error';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { RECORD_BOARD_SERIAL } from '@boardsesh/graphql/operations';
import { getHttpClient } from '../graphql/client';
import { getAuthToken } from '../auth-store';
import {
  createBluetoothAdapter,
  getNativeBleConnectedDevice,
  isNativeIosBleAdapter,
  subscribeNativeBleConnected,
} from './adapter-factory';
import { requestBleRuntimePermissions } from './use-ble-permissions';
import { describeBlePermissionDenial } from './android-location-permission';
import { manufacturerCompanyId } from './advertisement';
import type {
  BleAdapterOptions,
  BleDisconnectInfo,
  BleWriteDiagnostics,
  BluetoothAdapter,
  DevicePickerFn,
  DiscoveredDevice,
} from './types';
import type { HoldPlacement } from '../../components/board-renderer/types';
import { track } from '../analytics';
import { markClimbAction } from '../climb-view-session';
import { reportHandledError } from '../error-reporting';
import { clearBleDiagnosticsTags, setBleDiagnosticsTags } from '../sentry';
import { buildHoldColorOverrideSignature, type HoldColorOverrides } from '../hold-color-overrides';
import {
  clearStoredLastConnectedBoard,
  getStoredLastConnectedBoard,
  setStoredLastConnectedBoard,
  type StoredLastConnectedBoard,
} from './last-connected-board-store';
import type { BleWriteActivityStore } from './write-activity-store';
import { getBleEncodingSignature } from './encoding-signature';

// Exported for testing. Decides how a connect-failure category reaches error
// tracking:
//  - null  → don't report. The user dismissed the device picker
//    ('user_cancelled') — that's the app doing exactly what was asked, not a fault.
//  - 'warning' → environmental, not an app bug: the board is off, out of range,
//    or the GATT connect timed out ('board_not_found' / 'connect_failed').
//  - 'error' → a genuine fault worth surfacing ('unavailable' / 'service_missing'
//    / 'unknown').
export function bleConnectReportLevel(category: BleFailureCategory): 'warning' | 'error' | null {
  if (category === 'user_cancelled') return null;
  if (category === 'board_not_found' || category === 'connect_failed') return 'warning';
  return 'error';
}

// Per-write transport diagnostics → analytics props (#3230). Prefixed `ble` to
// sit beside the connect-time `bleChosenWriteType`/`bleMaxWriteWithoutResponse`
// props. Every field is optional (Android reports only its MTU/chunking story;
// old binaries none), and unreported fields are dropped rather than spread as
// undefined so the event payload carries only real values. Exported for testing.
export function bleWriteDiagnosticsProperties(
  diagnostics: BleWriteDiagnostics | null | undefined,
): Record<string, string | number | boolean> {
  if (!diagnostics) return {};
  const mappedProperties = {
    bleWriteOrigin: diagnostics.origin,
    bleWriteType: diagnostics.finalWriteType ?? diagnostics.writeType,
    bleInitialWriteType: diagnostics.initialWriteType,
    bleFinalWriteType: diagnostics.finalWriteType,
    bleWriteTypeSource: diagnostics.writeTypeSource,
    bleChunkSize: diagnostics.chunkSize,
    bleChunkCount: diagnostics.chunkCount,
    bleMaxWriteWithoutResponse: diagnostics.negotiatedMaxWriteWithoutResponse,
    bleNegotiatedMtu: diagnostics.negotiatedMtu,
    bleParkCount: diagnostics.parkCount,
    blePeripheralIsReadyFired: diagnostics.peripheralIsReadyFired,
    bleLastResumeSource: diagnostics.lastResumeSource,
    bleMaxParkMs: diagnostics.maxParkMs,
    bleTotalParkMs: diagnostics.totalParkMs,
    bleWatchdogTripped: diagnostics.watchdogTripped,
    bleCanSendAtTrip: diagnostics.canSendAtTrip,
    bleWriteDurationMs: diagnostics.durationMs,
    // `satisfies` keeps the literal honest if BleWriteDiagnostics grows an
    // incompatible field; the cast below only asserts what the filter
    // guarantees at runtime — no undefined values survive.
  } satisfies Record<string, string | number | boolean | undefined>;
  return Object.fromEntries(Object.entries(mappedProperties).filter(([, value]) => value !== undefined)) as Record<
    string,
    string | number | boolean
  >;
}

// Exported for testing — isolates the .packet extraction so regressions are caught.
//
// Empty frames deliberately send MoonBoard's clear-all `l##` frame (the builder
// marks that result `isClear`) — web parity (use-board-bluetooth.ts).
//
// Returns:
//  - false when a non-clear send encodes zero holds — every placement skipped,
//    or a degenerate frames string that parses to no placements. The builder
//    still emits `l##` for those, so writing it would silently dark the board
//    while the caller reported success; the caller surfaces the
//    incompatible-climb error instead.
//  - true after a successful write.
export async function dispatchMoonboardPacket(
  frames: string,
  write: BluetoothAdapter['write'],
  signal?: AbortSignal,
  numRows?: number,
  lightAdjacentHolds?: boolean,
): Promise<boolean> {
  const { packet, skippedRoleCount, skippedPositionCount, totalPlacements, isClear } = getMoonboardBluetoothPacket(
    frames,
    numRows,
    { lightAdjacentHolds },
  );
  const encodedCount = totalPlacements - skippedRoleCount - skippedPositionCount;
  if (!isClear && encodedCount === 0) {
    return false;
  }
  await write(packet, signal);
  return true;
}

/**
 * Outcome of a Woods send. The hook maps each case onto the user-facing
 * behaviour (alert, analytics, error report) — everything here is encode + write.
 */
export type WoodsDispatchResult =
  /** `sizeId` maps to no Woods LED table, so nothing could be encoded. */
  | { kind: 'unknown_size' }
  /**
   * A climb send whose every placement was skipped. Woods encodes "clear" as an
   * empty hold list, so writing that packet would silently dark the wall while
   * the caller reported success — refuse it the way the MoonBoard branch does.
   */
  | { kind: 'incompatible' }
  /**
   * Written. `cleared` marks the deliberate clear (empty frames, the bare `,!`);
   * the counts are the encoder's own, and a non-zero skip means the climb's
   * frames disagree with the board's LED table — the wall still lights what it
   * can, so that is a report, not a failure.
   */
  | {
      kind: 'sent' | 'cleared';
      size: WoodsBoardSize;
      skippedRoleCount: number;
      skippedPositionCount: number;
      totalPlacements: number;
    };

/**
 * Encode a Woods climb and write it, mirroring `dispatchMoonboardPacket`: the
 * packet building and the board-darking guard live here, the reporting stays with
 * the caller (which owns `t`, `track` and the board analytics properties).
 */
export async function dispatchWoodsPacket(
  frames: string,
  sizeId: number,
  write: BluetoothAdapter['write'],
  signal?: AbortSignal,
): Promise<WoodsDispatchResult> {
  const size = woodsSizeIdToDimension(sizeId);
  if (!size) return { kind: 'unknown_size' };

  // Woods encodes "clear" as an empty hold list (a bare `,!`), so empty frames
  // flow through the same path. Reject only the encoder's explicit multi-frame
  // incompatibility here; unrelated encoder failures must still surface.
  let woodsPacketResult: WoodsPacketResult;
  try {
    woodsPacketResult = getWoodsBluetoothPacket(frames, size);
  } catch (error) {
    if (error instanceof WoodsMultiFrameError) return { kind: 'incompatible' };
    throw error;
  }
  const { packet, skippedRoleCount, skippedPositionCount, totalPlacements } = woodsPacketResult;
  const skipped = skippedRoleCount + skippedPositionCount;
  if (frames !== '' && totalPlacements > 0 && skipped === totalPlacements) {
    return { kind: 'incompatible' };
  }

  await write(packet, signal);
  return {
    kind: frames === '' ? 'cleared' : 'sent',
    size,
    skippedRoleCount,
    skippedPositionCount,
    totalPlacements,
  };
}

// MoonBoard grid rows for the native configureBoard payload, so native
// re-encodes (widget intents, reconnect re-light) use the same serpentine grid
// as the JS send path — Mini strips are 12 rows, standard 18 (#3392). Undefined
// for Aurora boards, whose encoder has no grid maths.
export function moonboardNumRowsForNative(boardName: string | undefined, layoutId: number): number | undefined {
  return boardName === 'moonboard' ? getMoonBoardGeometryByLayoutId(layoutId).numRows : undefined;
}

// How many consecutive MoonBoard write failures (with no successful write in
// between) must occur before we conclude the link is dead and drop it. A
// MoonBoard's dead-link write surfaces as a generic `write_failed` — the same
// bucket a one-off transient hiccup lands in — and force-dropping a still-live
// link is costly on these boards: some controllers need a physical power cycle
// before they'll accept a new connection, so a wrong teardown can leave the user
// unable to reconnect at all. A genuine supervision-timeout drop fails every
// subsequent send, so a small streak separates it from a transient glitch (whose
// next send succeeds and resets the count) without dropping a live board.
export const MOONBOARD_WRITE_FAILURE_DROP_THRESHOLD = 2;

export type PickerState = {
  devices: DiscoveredDevice[];
  isScanning: boolean;
  handleSelect: (deviceId: string) => void;
  handleCancel: () => void;
};

// Identity of a board pairing: the silent-reconnect and adoption guards only
// trust a remembered/native connection while the active config still matches.
// Deliberately excludes set_ids — see the reconnectSerialForCurrentBoard note.
export function boardConfigKey(boardName: string, layoutId: number, sizeId: number): string {
  return `${boardName}::${layoutId}::${sizeId}`;
}

/**
 * Board type parsed from a BLE device name, covering both families: Aurora
 * names via the product-name prefix, MoonBoard via its name prefixes. Returns
 * undefined when the name identifies neither.
 */
function parseAnyBoardTypeFromDeviceName(deviceName?: string): string | undefined {
  if (!deviceName) return undefined;
  if (isMoonboardDeviceName(deviceName)) return 'moonboard';
  if (isWoodsDeviceName(deviceName)) return 'woods';
  return parseBoardTypeFromDeviceName(deviceName);
}

// 'moonboard' here is the Nordic-UART (non-Aurora) scan family: MoonBoard and
// Woods both advertise the UART service and need name-based matching.
function scanFamilyForBoard(boardName: string): 'aurora' | 'moonboard' {
  return boardName === 'moonboard' || boardName === 'woods' ? 'moonboard' : 'aurora';
}

// Transport preferences for the board in view. Woods takes acknowledged writes
// (protocol spec §8), which also routes it onto the JS ble-plx adapter on iOS —
// see createBluetoothAdapter.
function adapterOptionsForBoard(boardName: string): BleAdapterOptions {
  return { preferWriteWithResponse: boardName === 'woods' };
}

/**
 * Fire-and-forget GraphQL mutation recording the (serial, board config, API
 * level) seen on connect for the authenticated user. Mirrors the web app's
 * `recordBoardSerial`. Failures are swallowed — connect must not block on this.
 */
function recordBoardSerial(input: {
  serialNumber: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  apiLevel: number;
  boardUuid?: string;
}): void {
  // Canonicalise set IDs: dedupe + numeric sort, dropping any non-numeric token
  // so the value satisfies the backend's `^\d+(,\d+)*$` schema.
  const setIds = [
    ...new Set(
      input.setIds
        .split(',')
        .map((part) => part.trim())
        .filter((part) => /^\d+$/.test(part)),
    ),
  ]
    .sort((first, second) => Number(first) - Number(second))
    .join(',');
  if (!setIds) return;
  // The mutation requires auth, so firing it while signed out is a guaranteed
  // 401 round-trip on every anonymous connect. Skip when there's no stored
  // token. (Web threads a token through and fires regardless, but on mobile the
  // token lives in SecureStore, so a cheap async check here avoids the noise.)
  void getAuthToken().then((token) => {
    if (!token) return;
    return getHttpClient()
      .request(RECORD_BOARD_SERIAL, { input: { ...input, setIds } })
      .catch(() => {});
  });
}

type GetLedPlacementsFn = (boardName: string, layoutId: number, sizeId: number) => Record<number, number>;
let cachedGetLedPlacements: GetLedPlacementsFn | null = null;

export const convertToMirroredFramesString = (frames: string, holdsData: HoldPlacement[]): string => {
  const holdIdToMirroredIdMap = new Map<number, number>();
  for (const hold of holdsData) {
    if (hold.mirroredHoldId) {
      holdIdToMirroredIdMap.set(hold.id, hold.mirroredHoldId);
    }
  }

  return frames
    .split('p')
    .filter((hold) => hold)
    .map((holdEntry) => {
      const [holdId, stateCode] = holdEntry.split('r').map((str) => Number(str));
      const mirroredHoldId = holdIdToMirroredIdMap.get(holdId);

      if (mirroredHoldId === undefined) {
        throw new Error(`Mirrored hold ID is not defined for hold ID ${holdId}.`);
      }

      return `p${mirroredHoldId}r${stateCode}`;
    })
    .join('');
};

/**
 * Diagnostic context attached to Climb Sent to Board Success/Failure so PostHog
 * can tell WHAT was sent and WHY apart. Optional — callers that don't have it
 * (e.g. a manual mirror re-send) just omit it.
 */
export type BleSendContext = {
  /** Where the send came from: the queue auto-sender, an undo, a deliberate
   *  clear (passed by clearBoard), a wall-kiosk relight, or connect()'s own
   *  initial frame write (`connect` — the one send that can take the link with
   *  it, so it needs to be separable in analytics). */
  sendSource: 'auto' | 'undo' | 'clear' | 'wall-relight' | 'connect';
  targetQueueItemUuid?: string;
  climbUuid?: string;
  /** The climb's own board metadata, when known — lets a board/climb mismatch be seen. */
  climbBoardType?: string;
  climbLayoutId?: number | null;
};

export type SendFramesToBoard = (
  frames: string,
  mirrored?: boolean,
  signal?: AbortSignal,
  sendContext?: BleSendContext,
) => Promise<boolean | undefined>;

export type BluetoothDisconnectReason = 'user' | 'auto_disconnect';

export type BleDisconnectTrigger =
  | 'explicit_user'
  | 'auto_disconnect'
  | 'config_switch'
  | 'connection_replacement'
  | 'link_drop';

export type BleConnectionEnded = {
  reason: 'user' | 'unexpected';
  disconnectTrigger: BleDisconnectTrigger;
  connectionDurationSec: number;
  boardName: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  boardId?: number;
  inSession: boolean;
  /** Present only for unexpected transport drops. */
  disconnectInfo?: BleDisconnectInfo;
};

export type BleConnectionConfigSnapshot = {
  readonly boardName: string;
  readonly layoutId?: number;
  readonly sizeId?: number;
  readonly setIds?: string;
};

export type BleConnectionHandle = {
  generation: number;
  configIdentity: string;
  /** Immutable board config captured beside the adapter generation. Consumers
   * must use this for asynchronous connection work instead of rendered refs. */
  config: BleConnectionConfigSnapshot;
  /**
   * The board type this controller advertised in its BLE device name
   * (`Tension Board#12345@3`), captured at connect alongside the generation.
   *
   * Distinct from `config.boardName`, which is the route the climber is on.
   * Aurora numbers each board app separately, so a serial identifies hardware
   * only within a type — this is the field that keeps a serial lookup on the
   * box actually connected. `undefined` when the name identifies no board type.
   */
  advertisedBoardType?: string;
  /**
   * Attach the board-presence ID resolved for this exact connection. Returns
   * false when the generation/config is stale or a different ID already won.
   */
  setAnalyticsBoardId: (boardId: number) => boolean;
};

export type BleConnectInitialSend = {
  frames: string;
  mirrored: boolean;
  colorSignature: string;
  encodingSignature: string;
};

type ActiveBleConnectionLifetime = {
  adapter: BluetoothAdapter;
  generation: number;
  configIdentity: string;
  startedAtMs: number;
  attribution: Omit<BleConnectionEnded, 'reason' | 'disconnectTrigger' | 'connectionDurationSec' | 'disconnectInfo'>;
};

type UseBoardBluetoothOptions = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  /** Comma-separated set IDs of the active board, recorded against the serial on connect. */
  setIds?: string;
  /** UUID of the active (saved) board, linked to the serial recording. */
  boardUuid?: string;
  holdsData?: HoldPlacement[];
  ledColorOverrides?: LedColorOverrides;
  /** MoonBoard "V2" BLE feature: also light each active hold's firmware-
   * defined neighbour LED. No-op on Aurora boards. */
  moonboardLightAdjacentHolds?: boolean;
  /** Semantic packet-encoding identity derived alongside the preference above.
   * BluetoothProvider passes this once to both the connect seed and auto-sender. */
  encodingSignature?: string;
  analyticsBoardId?: number | null;
  analyticsInSession?: boolean;
  onConnectionEnded?: (connection: BleConnectionEnded) => void;
  /** Fired on every connection-state edge. A consumer must tolerate a `false`
   *  with no preceding `true`: when connect()'s initial write kills the link,
   *  the drop teardown fires `false` and connect() then bails before it would
   *  ever have fired `true` (#3875). */
  onConnectionChange?: (connected: boolean) => void;
  onConnectSuccess?: (serial: string | null, connection: BleConnectionHandle) => void;
  /** Reads whether this connection was made via the mismatch "Connect anyway"
   *  override, attached to connection + send analytics. */
  getConnectedViaMismatchOverride?: () => boolean;
  /** Provider-scoped external store for foreground JS write feedback. */
  writeActivityStore?: BleWriteActivityStore;
};

const KEEP_AWAKE_TAG = 'boardsesh-ble';

function connectionConfigIdentity(
  boardName: string | undefined,
  layoutId: number | undefined,
  sizeId: number | undefined,
  setIds: string | undefined,
): string {
  return `${boardName ?? ''}:${layoutId ?? ''}:${sizeId ?? ''}:${setIds ?? ''}`;
}

/**
 * Create a single AbortSignal that fires when either of the two input signals
 * is aborted. This lets us combine a caller-supplied signal with an internal
 * one without losing either. Callers must invoke `dispose` once the guarded
 * work settles — the caller-supplied signal can be long-lived (the
 * AutoSender's lifetime controller), and without the dispose every write
 * would leave one more dangling 'abort' listener on it for the rest of the
 * session.
 */
function mergeAbortSignals(signalA: AbortSignal, signalB: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  const detach = () => {
    signalA.removeEventListener('abort', onAbort);
    signalB.removeEventListener('abort', onAbort);
  };
  const onAbort = () => {
    controller.abort();
    detach();
  };

  if (signalA.aborted || signalB.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }

  signalA.addEventListener('abort', onAbort);
  signalB.addEventListener('abort', onAbort);

  return { signal: controller.signal, dispose: detach };
}

/**
 * Resolve the AbortSignal an adapter write runs under, plus a `dispose` to detach
 * any listeners the merge added.
 *
 * - **Native** (`platformOS !== 'web'`): merge the caller signal with the
 *   per-connection generation controller, so a reconnect (which aborts the
 *   generation controller) cancels this in-flight write.
 * - **Web** (`platformOS === 'web'`): pass the caller signal straight through with
 *   NO generation merge, mirroring the proven Next.js web app. On web a reconnect
 *   swaps in a fresh WebBluetoothAdapter + characteristic and disconnects the old
 *   one, so a stale write fails closed on its own — the merge buys nothing. The
 *   merge was also the one wrapper the working web path never had, sitting on the
 *   exact seam where Expo web relit the FIRST climb (connect() sends it with no
 *   caller signal, bypassing the merge) but risked silently no-op'ing the ones
 *   after (every AutoSender send passes a caller signal through the merge).
 *
 * Exported for testing.
 */
export function resolveWriteSignal(
  callerSignal: AbortSignal | undefined,
  generationSignal: AbortSignal,
  platformOS: typeof Platform.OS,
): { combinedSignal: AbortSignal; dispose: () => void } {
  const mergeGenerationSignal = platformOS !== 'web';
  const merged = callerSignal && mergeGenerationSignal ? mergeAbortSignals(callerSignal, generationSignal) : null;
  return {
    combinedSignal: merged ? merged.signal : (callerSignal ?? generationSignal),
    dispose: merged ? merged.dispose : () => {},
  };
}

export function useBoardBluetooth({
  boardName,
  layoutId,
  sizeId,
  setIds,
  boardUuid,
  holdsData,
  ledColorOverrides,
  moonboardLightAdjacentHolds = false,
  encodingSignature = getBleEncodingSignature(boardName, moonboardLightAdjacentHolds),
  analyticsBoardId,
  analyticsInSession = false,
  onConnectionEnded,
  onConnectionChange,
  onConnectSuccess,
  getConnectedViaMismatchOverride,
  writeActivityStore,
}: UseBoardBluetoothOptions) {
  const { t } = useTranslation('settings');
  // Connect-failure copy lives in the shared `common.bluetooth.*` keys so web
  // and mobile describe the same failure the same way.
  const { t: tCommon } = useTranslation('common');
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  // Remember the board (its reconnect handle + which config it was paired
  // against) so a later involuntary drop can be recovered with a silent reconnect
  // to the same board (the lightbulb tap, native shells). The handle is a serial
  // for Aurora boards and a BLE peripheral id for MoonBoards. Only valid while the
  // current route still points at the same board — switching board/layout/size
  // invalidates it and callers fall back to the picker. Mirrors the web
  // `reconnectSerialForCurrentBoard`.
  const [lastConnectedBoard, setLastConnectedBoard] = useState<StoredLastConnectedBoard | null>(null);
  const lastConnectedBoardRef = useRef(lastConnectedBoard);
  lastConnectedBoardRef.current = lastConnectedBoard;

  // Persist / forget the remembered board alongside the in-memory state so a
  // one-tap silent reconnect survives a cold start or provider remount, not just
  // the current session (#3609). Storage writes are fire-and-forget: a failure
  // just means the next launch falls back to the picker, never a thrown error.
  const rememberConnectedBoard = useCallback((board: StoredLastConnectedBoard) => {
    setLastConnectedBoard(board);
    void setStoredLastConnectedBoard(board).catch(() => {});
  }, []);
  const forgetConnectedBoard = useCallback(() => {
    setLastConnectedBoard(null);
    void clearStoredLastConnectedBoard().catch(() => {});
  }, []);

  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const apiLevelRef = useRef<number>(3);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);
  // One AbortController per connection generation, shared by every write of
  // that generation. connect()/disconnect() abort it so ALL in-flight and
  // queued writes against the old adapter cancel — a per-write controller
  // would only ever cover the most recent one.
  const writeAbortRef = useRef<AbortController | null>(null);
  // Serialises every adapter.write across all callers of sendFramesToBoard.
  // The AutoSender (first frame on climb change), the play-drawer playback
  // drain (subsequent frames) and the create-climb preview each guard only
  // their own writes, so without a shared mutex their independent latest-wins
  // loops can overlap at the GATT boundary. RNBleAdapter splits a packet into
  // 20-byte chunks written sequentially with inter-chunk delays — two
  // overlapping writes interleave chunks of two different packets and corrupt
  // both. Mirrors the web hook's writeChainRef; reset on connect/disconnect
  // so a hung write can't wedge the next connection's sends.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  // Consecutive MoonBoard `write_failed` count, reset by any successful write and
  // on connect/drop. Gates the dead-link teardown so a single transient write
  // error never drops a live board — see MOONBOARD_WRITE_FAILURE_DROP_THRESHOLD.
  const moonboardWriteFailureStreakRef = useRef(0);
  // True while a connect attempt is running. Guards against a second
  // concurrent connect (double-tapped lightbulb): both attempts would share
  // the singleton BLE manager, and the first attempt's scan teardown kills
  // the second attempt's scan, stranding the picker.
  const connectInFlightRef = useRef(false);
  // True after an explicit user disconnect, false again on the next deliberate
  // connect. While set, the native-connection adoption path is ignored — it
  // would otherwise race the in-flight native disconnect and re-establish the
  // connection the user just closed.
  const adoptionSuppressedRef = useRef(false);
  // Full config identity the live connection was established for. Includes set
  // IDs so a set-only route switch ends the old attribution generation rather
  // than allowing its asynchronous board resolve to bleed into the new setup.
  const connectedConfigIdentityRef = useRef<string | null>(null);
  // What connect() pushed as its initialFrames write, if any. The AutoSender
  // (mounted right after isConnected flips true) reads this one-shot seed so a
  // byte-identical current climb doesn't get re-sent immediately on connect —
  // a redundant full-frame write plus a doubled success haptic.
  const connectInitialSendRef = useRef<BleConnectInitialSend | null>(null);
  const configuredDeviceNameRef = useRef<string | undefined>(undefined);
  // The physical-link lifetime belongs to the adapter generation, not React's
  // rendered `isConnected` edge. It begins as soon as the adapter identity and
  // disconnect subscription are installed, before native configuration or the
  // initial frame write, and is consumed exactly once by a matching end path.
  const nextConnectionGenerationRef = useRef(0);
  const activeConnectionLifetimeRef = useRef<ActiveBleConnectionLifetime | null>(null);
  const onConnectionEndedRef = useRef(onConnectionEnded);
  onConnectionEndedRef.current = onConnectionEnded;
  // A connect callback can outlive the render which started its asynchronous
  // adapter request. Read session attribution when that request actually opens
  // a physical-link generation, rather than from the callback's stale closure.
  const analyticsInSessionRef = useRef(analyticsInSession);
  analyticsInSessionRef.current = analyticsInSession;

  const beginConnectionLifetime = useCallback(
    (adapter: BluetoothAdapter, generation: number, configIdentity: string) => {
      activeConnectionLifetimeRef.current = {
        adapter,
        generation,
        configIdentity,
        startedAtMs: Date.now(),
        attribution: {
          boardName: boardName ?? '',
          layoutId,
          sizeId,
          setIds,
          inSession: analyticsInSessionRef.current,
        },
      };
    },
    [boardName, layoutId, setIds, sizeId],
  );

  const createConnectionHandle = useCallback(
    (
      adapter: BluetoothAdapter,
      generation: number,
      configIdentity: string,
      config: BleConnectionConfigSnapshot,
      advertisedBoardType: string | undefined,
    ): BleConnectionHandle => ({
      generation,
      configIdentity,
      config,
      advertisedBoardType,
      setAnalyticsBoardId: (boardId: number): boolean => {
        const lifetime = activeConnectionLifetimeRef.current;
        if (
          !lifetime ||
          lifetime.adapter !== adapter ||
          lifetime.generation !== generation ||
          lifetime.configIdentity !== configIdentity
        ) {
          return false;
        }
        const existingBoardId = lifetime.attribution.boardId;
        if (existingBoardId !== undefined) {
          return existingBoardId === boardId;
        }
        lifetime.attribution.boardId = boardId;
        return true;
      },
    }),
    [],
  );

  const consumeConnectionLifetime = useCallback(
    (
      expectedAdapter: BluetoothAdapter,
      expectedGeneration: number,
      reason: BleConnectionEnded['reason'],
      disconnectTrigger: BleDisconnectTrigger,
      disconnectInfo?: BleDisconnectInfo,
      notify: boolean = true,
    ): boolean => {
      const lifetime = activeConnectionLifetimeRef.current;
      if (!lifetime || lifetime.adapter !== expectedAdapter || lifetime.generation !== expectedGeneration) {
        return false;
      }

      activeConnectionLifetimeRef.current = null;
      if (notify) {
        onConnectionEndedRef.current?.({
          ...lifetime.attribution,
          reason,
          disconnectTrigger,
          connectionDurationSec: Math.max(0, Math.round((Date.now() - lifetime.startedAtMs) / 1000)),
          ...(reason === 'unexpected' && disconnectInfo ? { disconnectInfo } : {}),
        });
      }
      return true;
    },
    [],
  );

  // ledColorOverrides narrowed to string values, shared by the connect and
  // adoption configureBoard calls so both push identical overrides natively.
  const sanitizedColorOverrides = useMemo(() => {
    if (!ledColorOverrides) return undefined;
    return Object.fromEntries(
      Object.entries(ledColorOverrides).filter(([, value]) => typeof value === 'string') as [string, string][],
    );
  }, [ledColorOverrides]);
  const colorSignature = useMemo(
    () => buildHoldColorOverrideSignature((sanitizedColorOverrides ?? {}) as HoldColorOverrides),
    [sanitizedColorOverrides],
  );

  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const pickerRejectRef = useRef<((error: Error) => void) | null>(null);

  // Keep the screen awake while connected to a board
  useEffect(() => {
    if (isConnected) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [isConnected]);

  const devicePicker = useCallback<DevicePickerFn>((subscribe) => {
    return new Promise<string>((resolve, reject) => {
      pickerRejectRef.current = reject;

      const cleanup = () => {
        pickerRejectRef.current = null;
        setPickerState(null);
      };

      const handleSelect = (deviceId: string) => {
        cleanup();
        resolve(deviceId);
      };

      const handleCancel = () => {
        cleanup();
        reject(new Error('Device selection cancelled'));
      };

      setPickerState({ devices: [], isScanning: true, handleSelect, handleCancel });

      subscribe(
        (devices) => {
          setPickerState((prev) => (prev ? { ...prev, devices } : null));
        },
        () => {
          // Scan window closed — drop the spinner. The picker stays open (a
          // device was found but not yet picked, or it shows the empty state).
          setPickerState((prev) => (prev ? { ...prev, isScanning: false } : null));
        },
      );
    });
  }, []);

  const clearConnectionAfterDrop = useCallback(
    (expectedAdapter: BluetoothAdapter) => {
      // A callback from a replaced adapter must not tear down the new link.
      if (adapterRef.current !== expectedAdapter) return;
      unsubDisconnectRef.current?.();
      unsubDisconnectRef.current = null;
      adapterRef.current = null;
      configuredDeviceNameRef.current = undefined;
      connectedConfigIdentityRef.current = null;
      writeAbortRef.current?.abort();
      writeAbortRef.current = null;
      writeChainRef.current = Promise.resolve();
      writeActivityStore?.reset();
      moonboardWriteFailureStreakRef.current = 0;
      setIsConnected(false);
      onConnectionChange?.(false);
      // Drop the connect-time BLE diagnostic tags so a later unrelated error
      // doesn't carry stale ble_* tags from this (now-dead) connection.
      clearBleDiagnosticsTags();
      // Two callers reach here: the adapter's own disconnect event (the adapter
      // already self-cleaned, so disconnect() is now a no-op), and the
      // write-failure drop path (isDisconnectionError). In the latter the
      // RNBleAdapter's onDeviceDisconnected subscription and a possibly half-alive
      // native link would otherwise leak — dispose explicitly.
      void expectedAdapter.disconnect().catch(() => {});
    },
    [onConnectionChange, writeActivityStore],
  );

  const handleDisconnection = useCallback(
    (expectedAdapter: BluetoothAdapter, expectedGeneration: number, info?: BleDisconnectInfo) => {
      const lifetime = activeConnectionLifetimeRef.current;
      if (
        adapterRef.current !== expectedAdapter ||
        !lifetime ||
        lifetime.adapter !== expectedAdapter ||
        lifetime.generation !== expectedGeneration
      ) {
        return;
      }
      consumeConnectionLifetime(expectedAdapter, expectedGeneration, 'unexpected', 'link_drop', info);
      clearConnectionAfterDrop(expectedAdapter);
    },
    [clearConnectionAfterDrop, consumeConnectionLifetime],
  );

  const sendFramesToBoard = useCallback(
    async (frames: string, mirrored: boolean = false, signal?: AbortSignal, sendContext?: BleSendContext) => {
      if (!adapterRef.current || !boardName || layoutId === undefined || sizeId === undefined) {
        // The auto-sender only mounts while connected, so a send arriving here
        // means a connected-but-not-ready window: the adapter was torn down, or
        // the active board props haven't propagated yet. Record it — otherwise
        // the send vanishes with no trace and reads as a dead tap. Not a Failure
        // (no write was attempted). boardName/layoutId/sizeId may be undefined
        // (that's why we bailed); undefined props are simply dropped from the event.
        track(SHARED_EVENTS.ClimbSentToBoardSkipped, {
          skipReason: !adapterRef.current ? 'no_adapter' : 'no_board_config',
          boardName,
          layoutId,
          sizeId,
          climbUuid: sendContext?.climbUuid,
          sendSource: sendContext?.sendSource,
        });
        return;
      }
      // Resolved here (where layoutId is narrowed to a number) so the nested
      // performSend closure can use it. Mini LED strips are 12 rows, standard 18.
      const moonNumRows = getMoonBoardGeometryByLayoutId(layoutId).numRows;
      const boardAnalyticsProperties = {
        boardName,
        layoutId,
        sizeId,
        mirrored,
        boardId: analyticsBoardId ?? undefined,
        connectedViaMismatchOverride: getConnectedViaMismatchOverride?.() ?? false,
        ...sendContext,
      };

      // Lazily create the per-connection-generation controller so connect()
      // can cancel every write of the old generation at once.
      if (!writeAbortRef.current) {
        writeAbortRef.current = new AbortController();
      }
      const generationSignal = writeAbortRef.current.signal;

      // Resolve the signal the adapter write runs under. Native merges the caller
      // signal with the generation controller; web passes the caller signal
      // straight through (see resolveWriteSignal).
      const { combinedSignal, dispose: disposeWriteSignal } = resolveWriteSignal(signal, generationSignal, Platform.OS);

      const performSend = async (): Promise<boolean | undefined> => {
        // Transport diagnostics of the write that just settled (#3230) — iOS
        // native adapter (full flow-control story) or ble-plx (MTU/chunking
        // only); null on web-era adapters and old binaries. Read from the
        // adapter INSTANCE that performed the send, not the mutable ref: a
        // mid-write link drop runs clearConnectionAfterDrop (which nulls
        // adapterRef) before this send's catch fetches, and the failures that
        // race that way are exactly the ones whose diagnostics matter. Never
        // let the fetch itself fail an already-settled send.
        let sendAdapter: BluetoothAdapter | null = null;
        let sendGeneration: number | null = null;
        const fetchWriteDiagnostics = async (): Promise<BleWriteDiagnostics | null> =>
          (await sendAdapter?.getLastWriteDiagnostics?.().catch(() => null)) ?? null;
        try {
          // The send may have queued behind another write; by the time it runs
          // the connection generation may be gone (reconnect/disconnect) — bail
          // before touching the (possibly new) adapter. An aborted send is the
          // routine cancel path (unmount / generation swap) and stays silent; an
          // adapter that vanished WITHOUT an abort is the surprising "dropped
          // mid-queue" variant worth recording so it isn't a silent dead tap.
          if (combinedSignal.aborted) return;
          if (!adapterRef.current) {
            track(SHARED_EVENTS.ClimbSentToBoardSkipped, {
              ...boardAnalyticsProperties,
              skipReason: 'adapter_lost',
            });
            return;
          }
          sendAdapter = adapterRef.current;
          const activeLifetime = activeConnectionLifetimeRef.current;
          sendGeneration = activeLifetime?.adapter === sendAdapter ? activeLifetime.generation : null;

          if (boardName === 'moonboard') {
            const sent = await dispatchMoonboardPacket(
              frames,
              adapterRef.current.write.bind(adapterRef.current),
              combinedSignal,
              moonNumRows,
              moonboardLightAdjacentHolds,
            );
            // false = the climb encoded zero holds (every placement skipped, or
            // a degenerate frames string). The packet builder would emit the
            // clear-all packet `l##`, darking the board, so dispatchMoonboardPacket
            // refuses to write. Surface the same incompatible-climb error the
            // Aurora branch uses instead of letting the AutoSender buzz success on
            // a dark board.
            if (!sent) {
              console.warn('[BLE] All MoonBoard placements skipped — climb has unrecognised hold data');
              Alert.alert(t('ble.sendFailedTitle'), t('ble.errorIncompatible'));
              track(SHARED_EVENTS.ClimbSentToBoardFailure, {
                ...boardAnalyticsProperties,
                failureReason: 'incompatible_climb',
              });
              return false;
            }
            // A write just landed, so the link is alive — clear the dead-link streak.
            moonboardWriteFailureStreakRef.current = 0;
            if (frames === '') {
              // Deliberate clear-all just went out as `l##`: community firmware
              // (ArduinoMoonBoardLED) clears every LED on each incoming frame;
              // unverified on official Moon controllers (at worst a no-op). Only a
              // user-initiated clear counts as "lights cleared" — an auto-sent
              // climb with empty frames darks the wall (Aurora parity) but is not
              // a clear action.
              if (sendContext?.sendSource === 'clear') {
                track(SHARED_EVENTS.BoardLightsCleared, boardAnalyticsProperties);
              }
              return true;
            }
            track(SHARED_EVENTS.ClimbSentToBoardSuccess, {
              ...boardAnalyticsProperties,
              ...bleWriteDiagnosticsProperties(await fetchWriteDiagnostics()),
            });
            // Board-render A/B telemetry (issue #2202): a no-op unless this
            // climb has an open view from markClimbViewed (queue-provider's
            // setCurrentClimb).
            if (sendContext?.climbUuid) markClimbAction(sendContext.climbUuid, 'ble');
            return true;
          }

          if (boardName === 'woods') {
            const woodsResult = await dispatchWoodsPacket(
              frames,
              sizeId,
              adapterRef.current.write.bind(adapterRef.current),
              combinedSignal,
            );

            if (woodsResult.kind === 'unknown_size') {
              console.error(`[BLE] Unknown Woods board size_id ${sizeId}; cannot map to an LED table.`);
              Alert.alert(t('ble.sendFailedTitle'), t('ble.errorLedMissing'));
              track(SHARED_EVENTS.ClimbSentToBoardFailure, {
                ...boardAnalyticsProperties,
                failureReason: 'missing_led_placements',
              });
              return false;
            }

            if (woodsResult.kind === 'incompatible') {
              console.warn('[BLE] All Woods placements skipped — climb has unrecognised hold data');
              Alert.alert(t('ble.sendFailedTitle'), t('ble.errorIncompatible'));
              track(SHARED_EVENTS.ClimbSentToBoardFailure, {
                ...boardAnalyticsProperties,
                failureReason: 'incompatible_climb',
              });
              return false;
            }

            // A partial skip still lights the wall, just short a hold or two, so it
            // must not fail the send — but it means the climb's frames disagree with
            // the board's LED table. The encoder is silent by design (library code
            // that logs nothing), so the counts it returns are the only trace.
            // Record them so a real wall reporting "two holds missing" is
            // diagnosable from the field. Matches the web MoonBoard branch's
            // partial-skip report.
            const woodsSkipped = woodsResult.skippedRoleCount + woodsResult.skippedPositionCount;
            if (woodsSkipped > 0) {
              reportHandledError(
                new Error(
                  `[BLE] ${woodsSkipped} of ${woodsResult.totalPlacements} Woods placements skipped (${woodsResult.size})`,
                ),
                {
                  level: 'warning',
                  tags: { source: 'ble-send', board: 'woods' },
                  extra: {
                    skippedRoleCount: woodsResult.skippedRoleCount,
                    skippedPositionCount: woodsResult.skippedPositionCount,
                    totalPlacements: woodsResult.totalPlacements,
                  },
                },
              );
            }

            if (woodsResult.kind === 'cleared') {
              // The bare `,!` just cleared the wall. Only a user-initiated clear
              // counts as one; an auto-sent empty climb darks the board without
              // being a clear action (MoonBoard/Aurora parity above).
              if (sendContext?.sendSource === 'clear') {
                track(SHARED_EVENTS.BoardLightsCleared, boardAnalyticsProperties);
              }
              return true;
            }
            track(SHARED_EVENTS.ClimbSentToBoardSuccess, {
              ...boardAnalyticsProperties,
              ...bleWriteDiagnosticsProperties(await fetchWriteDiagnostics()),
            });
            // Board-render A/B telemetry (issue #2202): a no-op unless this
            // climb has an open view from markClimbViewed (queue-provider's
            // setCurrentClimb).
            if (sendContext?.climbUuid) markClimbAction(sendContext.climbUuid, 'ble');
            return true;
          }

          // Empty frames = "clear all LEDs" for Aurora boards. Only a
          // user-initiated clear is tracked; auto-sent empty frames clear the
          // wall (long-standing Aurora behaviour) without counting as one.
          if (frames === '') {
            const clearResult = getAuroraBluetoothPacket('', {}, boardName as AuroraBoardName, apiLevelRef.current);
            await adapterRef.current.write(clearResult.packet, combinedSignal);
            if (sendContext?.sendSource === 'clear') {
              track(SHARED_EVENTS.BoardLightsCleared, boardAnalyticsProperties);
            }
            return true;
          }

          let framesToSend = frames;

          if (mirrored && boardSupportsMirroring(boardName, layoutId)) {
            // On a board that supports mirroring, a mirrored send REQUIRES the
            // hold map to produce mirrored frames. If it's missing/empty we must
            // refuse rather than send the original (un-mirrored) frames — that
            // would light the wrong holds on the wall while the AutoSender buzzed
            // success. Web parity (use-board-bluetooth.ts:397-403).
            if (!holdsData || holdsData.length === 0) {
              console.error(
                `[BLE] Cannot mirror frames: holdsData is missing or empty for ${boardName} layout=${layoutId}`,
              );
              Alert.alert(t('ble.sendFailedTitle'), t('ble.errorIncompatible'));
              track(SHARED_EVENTS.ClimbSentToBoardFailure, {
                ...boardAnalyticsProperties,
                failureReason: 'missing_mirror_data',
              });
              return false;
            }
            framesToSend = convertToMirroredFramesString(frames, holdsData);
          }

          if (!cachedGetLedPlacements) {
            const mod = await import('@boardsesh/board-constants/led-placements');
            cachedGetLedPlacements = mod.getLedPlacements as GetLedPlacementsFn;
          }
          const getLedPlacementsFn = cachedGetLedPlacements;
          const placementPositions = getLedPlacementsFn(boardName, layoutId, sizeId);

          if (Object.keys(placementPositions).length === 0) {
            console.error(
              `[BLE] LED placement map is empty for ${boardName} layout=${layoutId} size=${sizeId}. Board configuration may be incorrect or LED data may need regeneration.`,
            );
            Alert.alert(t('ble.sendFailedTitle'), t('ble.errorLedMissing'));
            track(SHARED_EVENTS.ClimbSentToBoardFailure, {
              ...boardAnalyticsProperties,
              failureReason: 'missing_led_placements',
            });
            return false;
          }

          const result = getAuroraBluetoothPacket(
            framesToSend,
            placementPositions,
            boardName as AuroraBoardName,
            apiLevelRef.current,
            ledColorOverrides,
          );

          const skippedCount = result.skippedPositionCount + result.skippedRoleCount;

          if (skippedCount > 0 && result.packet.length === 0) {
            console.warn(`[BLE] All ${result.totalPlacements} placements skipped — climb incompatible with board`);
            Alert.alert(t('ble.sendFailedTitle'), t('ble.errorIncompatible'));
            track(SHARED_EVENTS.ClimbSentToBoardFailure, {
              ...boardAnalyticsProperties,
              failureReason: 'incompatible_climb',
              skippedPositionCount: result.skippedPositionCount,
              skippedRoleCount: result.skippedRoleCount,
              totalPlacements: result.totalPlacements,
            });
            return false;
          }

          if (skippedCount > 0) {
            console.warn(`[BLE] ${skippedCount} of ${result.totalPlacements} placements skipped`);
          }

          await adapterRef.current.write(result.packet, combinedSignal);
          track(SHARED_EVENTS.ClimbSentToBoardSuccess, {
            ...boardAnalyticsProperties,
            ...bleWriteDiagnosticsProperties(await fetchWriteDiagnostics()),
          });
          // Board-render A/B telemetry (issue #2202): a no-op unless this
          // climb has an open view from markClimbViewed (queue-provider's
          // setCurrentClimb).
          if (sendContext?.climbUuid) markClimbAction(sendContext.climbUuid, 'ble');
          return true;
        } catch (error) {
          // An aborted write (unmount, or a reconnect cancelling the old
          // generation) is not a failure — some adapters surface it as a
          // DOMException, others reject with their own cancellation error after
          // the signal fired, so check the signal too.
          if (combinedSignal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            return;
          }
          const bleFailureReason = classifyBleFailureReason(error);
          console.error('Error sending frames to board:', error);
          const writeDiagnostics = await fetchWriteDiagnostics();
          track(SHARED_EVENTS.ClimbSentToBoardFailure, {
            ...boardAnalyticsProperties,
            failureReason: bleFailureReason,
            ...bleWriteDiagnosticsProperties(writeDiagnostics),
          });
          // A write that fails because the link is gone is a lost link. The
          // predicate matches the native adapters' "not connected" / "disconnected
          // during write" wording — a definite drop — so tear down immediately.
          const lostLink = isDisconnectionError(error);
          // On a MoonBoard a genuine link-timeout drop (CoreBluetooth error 6)
          // slips past that predicate ("No board is connected") and falls into the
          // generic `write_failed` bucket — but so does a one-off transient write
          // error on a still-live link. Dropping a live MoonBoard is costly (some
          // controllers need a power cycle before a new connection), so we only
          // treat it as dead after consecutive failures with no success between:
          // a real drop fails every send, a glitch's next send resets the streak.
          // The native self-recovery buckets (`write_timeout` /
          // `write_recovery_failed`) never count — the native layer cycles those.
          const moonboardWriteFailed = boardName === 'moonboard' && bleFailureReason === 'write_failed';
          if (moonboardWriteFailed) {
            moonboardWriteFailureStreakRef.current += 1;
          }
          const moonboardDeadLink =
            moonboardWriteFailed && moonboardWriteFailureStreakRef.current >= MOONBOARD_WRITE_FAILURE_DROP_THRESHOLD;
          // A dropped link is routine on these last-connection-wins boards
          // (another climber grabbed it, or it disconnected mid-session), so keep
          // it a filterable warning rather than a full error that drowns real
          // write bugs. Already tracked above via ClimbSentToBoardFailure. Only
          // downgrade a MoonBoard `write_failed` once the streak *confirms* a dead
          // link (moonboardDeadLink) — the first, still-ambiguous failure could be
          // a genuine write bug unrelated to the supervision-timeout pattern, and
          // that should still surface as an error.
          reportHandledError(error, {
            level: lostLink || moonboardDeadLink ? 'warning' : 'error',
            tags: { source: 'ble-send', failure_reason: bleFailureReason },
            extra: writeDiagnostics ? { bleWriteDiagnostics: writeDiagnostics } : undefined,
          });
          // Mark the connection lost so the lightbulb stops showing "connected"
          // and a deliberate reconnect can run. The adapter's disconnect event may
          // never fire (or arrive only after iOS's slow supervision timeout), so a
          // failed write is often the first — sometimes only — signal we get.
          if (lostLink || moonboardDeadLink) {
            // The tug-of-war signal (another device grabbed a shared board) only
            // fits the predicate-matched case; a MoonBoard link timeout isn't a
            // steal, so don't mislabel it.
            if (lostLink) {
              track(SHARED_EVENTS.BluetoothConnectionStolen, { boardName, layoutId, sizeId });
            }
            if (sendAdapter && sendGeneration !== null) {
              handleDisconnection(sendAdapter, sendGeneration, { source: 'write-failure' });
            }
          }
          return false;
        } finally {
          disposeWriteSignal();
        }
      };

      // Queue behind whatever write is already running or pending.
      // writeChainRef.current is never left rejected (the bookkeeping below
      // coerces both outcomes), so a single fulfilled-arm .then suffices here;
      // the rejected arm below is belt-and-suspenders so a future edit that
      // lets performSend throw still can't wedge the chain.
      const releaseWriteActivity = writeActivityStore?.begin();
      const queuedSend = writeChainRef.current.then(performSend);
      writeChainRef.current = queuedSend.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await queuedSend;
      } finally {
        releaseWriteActivity?.();
      }
    },
    [
      boardName,
      layoutId,
      sizeId,
      holdsData,
      ledColorOverrides,
      moonboardLightAdjacentHolds,
      analyticsBoardId,
      handleDisconnection,
      getConnectedViaMismatchOverride,
      writeActivityStore,
      t,
    ],
  );

  const connect = useCallback(
    async (initialFrames?: string, mirrored?: boolean, targetSerial?: string, targetDeviceId?: string) => {
      if (!boardName) {
        console.error('Cannot connect to Bluetooth without board name');
        return false;
      }

      // A connect is already running (double-tapped lightbulb, or a second
      // surface racing the first). Both attempts would share the singleton BLE
      // manager and tear down each other's scans, so ignore the second tap.
      if (connectInFlightRef.current) {
        return false;
      }
      connectInFlightRef.current = true;
      // A deliberate connect re-arms native-connection adoption after an
      // earlier explicit disconnect suppressed it.
      adoptionSuppressedRef.current = false;

      setLoading(true);

      // Hoisted so the catch can read the adapter's post-mortem connect
      // diagnostics (which services the board exposed) for a service_missing
      // report (#3480); `adapter` itself is block-scoped to the try.
      let connectAdapter: BluetoothAdapter | null = null;

      try {
        const permissionsGranted = await requestBleRuntimePermissions({ requestNotificationPermission: true });
        if (!permissionsGranted) {
          // The Alert is the only trace this path used to leave — an entire
          // class of "Bluetooth doesn't work" was invisible in telemetry.
          void describeBlePermissionDenial().then((denialContext) => {
            track(SHARED_EVENTS.BluetoothPermissionDenied, { ...denialContext, surface: 'connect', boardName });
          });
          Alert.alert(t('ble.permissionRequired'), t('ble.errorPermissionDenied'));
          return false;
        }

        const adapter = createBluetoothAdapter(
          devicePicker,
          scanFamilyForBoard(boardName),
          adapterOptionsForBoard(boardName),
        );
        connectAdapter = adapter;

        const available = await adapter.isAvailable();
        if (!available) {
          Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.unavailable'));
          return false;
        }

        // Abort every in-flight or queued write from the previous connection
        // generation so nothing keeps writing on a potentially-disconnected
        // device, and unblock the write chain in case a write hung.
        writeAbortRef.current?.abort();
        writeAbortRef.current = null;
        writeChainRef.current = Promise.resolve();
        writeActivityStore?.reset();
        // Fresh connection generation — a stale dead-link streak must not carry over.
        moonboardWriteFailureStreakRef.current = 0;

        // Clean up any existing adapter. A live link replaced by a new connect
        // is a deliberate end of the old generation and keeps the old board's
        // snapshotted attribution.
        if (adapterRef.current) {
          const previousAdapter = adapterRef.current;
          const previousLifetime = activeConnectionLifetimeRef.current;
          if (previousLifetime?.adapter === previousAdapter) {
            consumeConnectionLifetime(previousAdapter, previousLifetime.generation, 'user', 'connection_replacement');
          }
          unsubDisconnectRef.current?.();
          unsubDisconnectRef.current = null;
          adapterRef.current = null;
          connectedConfigIdentityRef.current = null;
          configuredDeviceNameRef.current = undefined;
          try {
            await previousAdapter.disconnect();
          } catch {
            // The previous adapter may already be torn down — e.g. after a
            // write-failure disconnect (another device grabbed the board) the
            // link is dead, and disconnecting a dead handle can reject. We're
            // replacing it anyway, so swallow it rather than aborting the
            // reconnect with a spurious error.
          }
        }

        // Surface the scan on the session-recording timeline / PostHog. `reconnect`
        // distinguishes a deliberate same-board reconnect (lightbulb — by serial for
        // Aurora, by device id for MoonBoard) from a fresh picker-driven connect.
        track(SHARED_EVENTS.BluetoothScanStarted, {
          boardName,
          layoutId,
          sizeId,
          reconnect: !!targetSerial || !!targetDeviceId,
        });

        const connection = await adapter.requestAndConnect(targetSerial, targetDeviceId);
        apiLevelRef.current = parseApiLevel(connection.deviceName);
        configuredDeviceNameRef.current = connection.deviceName;

        const connectionGeneration = nextConnectionGenerationRef.current + 1;
        nextConnectionGenerationRef.current = connectionGeneration;
        adapterRef.current = adapter;
        // Assigned here, beside adapterRef, rather than after the initial send:
        // the physical link exists from this line on, and the config-switch effect
        // early-returns while this ref is null. Leaving it null across the awaited
        // initial write meant a board/layout/size/set change landing in that window
        // couldn't tear the (now-wrong) connection down. Both drop paths
        // (clearConnectionAfterDrop, teardownConnection) already clear it.
        const connectionConfig = { boardName: boardName ?? '', layoutId, sizeId, setIds };
        const connectionIdentity = connectionConfigIdentity(boardName, layoutId, sizeId, setIds);
        connectedConfigIdentityRef.current = connectionIdentity;
        unsubDisconnectRef.current = adapter.onDisconnect((info) => {
          handleDisconnection(adapter, connectionGeneration, info);
        });
        beginConnectionLifetime(adapter, connectionGeneration, connectionIdentity);
        const connectionHandle = createConnectionHandle(
          adapter,
          connectionGeneration,
          connectionIdentity,
          connectionConfig,
          parseAnyBoardTypeFromDeviceName(connection.deviceName),
        );

        // Push board configuration into the native BoardBleManager so the
        // Dynamic Island widget intent path (next/prev tapped while the app
        // is backgrounded) can encode wall packets from queue items stored in
        // the App Group without going through JS. No-op on Android.
        if (
          isNativeIosBleAdapter(adapter) &&
          typeof adapter.configureBoard === 'function' &&
          layoutId !== undefined &&
          sizeId !== undefined
        ) {
          try {
            await adapter.configureBoard({
              boardName,
              layoutId,
              sizeId,
              apiLevel: apiLevelRef.current,
              deviceName: connection.deviceName,
              colorOverrides: sanitizedColorOverrides,
              numRows: moonboardNumRowsForNative(boardName, layoutId),
              lightAdjacentHolds: moonboardLightAdjacentHolds,
            });
          } catch (error) {
            console.warn('[BLE] Failed to push board configuration to native side:', error);
          }
        }

        // Parse serial for Aurora boards and record the (serial, config, API
        // level) mapping for serial→config lookups. Moonboard device names
        // don't carry a serial in this format, so they're skipped.
        let parsedSerial: string | null = null;
        if (boardName !== 'moonboard' && connection.deviceName) {
          parsedSerial = parseSerialNumber(connection.deviceName) ?? null;
          if (parsedSerial && boardName && layoutId !== undefined && sizeId !== undefined && setIds) {
            recordBoardSerial({
              serialNumber: parsedSerial,
              boardName,
              layoutId,
              sizeId,
              setIds,
              apiLevel: apiLevelRef.current,
              boardUuid,
            });
          }
        }

        // Remember the board (keyed to the config it was paired against) so an
        // involuntary drop can be recovered by a one-tap reconnect. Aurora boards
        // reconnect by their parseable serial; a MoonBoard has none, so we remember
        // its BLE peripheral id and reconnect by matching that on the next scan.
        // Without a full config there is no usable key (the reconnect comparison
        // against currentConfigKey could never match).
        if (layoutId !== undefined && sizeId !== undefined) {
          const configKey = boardConfigKey(boardName, layoutId, sizeId);
          if (parsedSerial) {
            rememberConnectedBoard({ configKey, serial: parsedSerial });
          } else if (boardName === 'moonboard') {
            rememberConnectedBoard({ configKey, deviceId: connection.deviceId });
          }
        }

        // Send initial frames if provided. `sendSource: 'connect'` makes the
        // resulting Climb Sent to Board Success/Failure/Skipped attributable to
        // this connect-time write instead of having to be inferred from a
        // millisecond gap against Bluetooth Connection Success.
        let initialSendResult: boolean | undefined;
        if (initialFrames) {
          initialSendResult = await sendFramesToBoard(initialFrames, mirrored, undefined, { sendSource: 'connect' });
        }

        // The initial write can kill the link it just rode in on: out of range
        // during the handshake, the box powered off, or a second phone stealing a
        // last-connection-wins board. Both teardown routes (sendFramesToBoard's
        // isDisconnectionError branch, and the adapter's own onDisconnect
        // subscription registered above) run clearConnectionAfterDrop, which nulls
        // adapterRef. Without this check connect() went on to setIsConnected(true)
        // over a null adapter: a lit lightbulb, every later send early-returning
        // with skipReason 'no_adapter', and onConnectSuccess claiming a board hold
        // in board presence that we cannot write to (#3875).
        //
        // A third, non-drop route reaches this bail: the config-switch effect
        // below. Its deps (boardName/layoutId/sizeId/setIds) are route-derived provider
        // state, so navigating to a different board while the awaited write is in
        // flight re-runs it, and — since connectedConfigIdentityRef is assigned when
        // the link opens rather than after this send — it tears the now-stale
        // connection down. Bailing is right (the adapter really is gone), but the
        // alert then reads "move closer" for what was a deliberate switch. Accepted:
        // the copy is mildly wrong on a path where the user has already navigated
        // away, and the alternative is streaming the new config's LED map to the old
        // wall. Revisit with a distinct reason if it shows up in support.
        //
        // The signal is adapter IDENTITY, not initialSendResult. Do not "simplify"
        // this to `if (initialSendResult === false)`:
        //   - false does NOT mean the link died. It is also returned for
        //     incompatible_climb, missing_mirror_data, missing_led_placements and
        //     every ordinary write rejection (write_failed, write_timeout,
        //     characteristic_unavailable). Failing the connect on those would
        //     strand a live adapter behind a dark bulb — the mirror-image bug.
        //   - false is NOT returned when the adapter's onDisconnect fires during
        //     the write: write() resolves, the send reports success, and the
        //     teardown has already happened. The boolean misses that case entirely.
        if (adapterRef.current !== adapter) {
          // clearConnectionAfterDrop already flipped isConnected to false, aborted
          // this write generation, disposed the adapter and cleared the Sentry BLE
          // tags — including onConnectionChange?.(false) without a preceding true,
          // which no consumer reads today but a future one must tolerate.
          connectInitialSendRef.current = null;
          Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.connectFailed'));
          track(SHARED_EVENTS.BluetoothConnectionFailed, {
            boardName,
            layoutId,
            sizeId,
            // Sits alongside the classifyBleFailure categories used by the catch
            // block below; this one is only reachable from the initial write.
            failureReason: 'dropped_after_connect',
          });
          return false;
        }

        // Seed the AutoSender's dedup with what was written so it doesn't
        // immediately repeat the identical frame (and its success haptic) when it
        // mounts on isConnected — but ONLY when the write actually landed. Seeding
        // after a failed write told the AutoSender the wall already showed this
        // climb, so it (a) skipped the write and left a connected board dark until
        // the climber navigated away and back, and (b) hit the byte-identical
        // branch that fires onWallConfirmed, reporting a lit climb to the party /
        // presence feed over a dark wall. Assigned on every exit path (including
        // the bail above), so a later native-connection adoption — which never
        // assigns this ref — can't inherit a stale seed either.
        //
        // Accepted cost: an incompatible initialFrames no longer suppresses the
        // AutoSender's own attempt, so the climber can see ble.errorIncompatible
        // twice. That is deliberate — suppressing the second alert also suppresses
        // the truthful "nothing is on the wall" state and puts a phantom
        // onWallConfirmed on the party feed. One extra alert beats telling the
        // crew a climb is lit when the wall is dark.
        connectInitialSendRef.current =
          initialFrames && initialSendResult === true
            ? { frames: initialFrames, mirrored: !!mirrored, colorSignature, encodingSignature }
            : null;

        setIsConnected(true);
        onConnectionChange?.(true);
        onConnectSuccess?.(parsedSerial, connectionHandle);
        // Connect-time BLE write diagnostics (iOS native adapter only; null on
        // Android/web and on binaries too old to report them). Set as global
        // Sentry tags so they ride any later write-stall report, and recorded on
        // the success event so PostHog can correlate the chosen write type with
        // send failures (#3181 follow-up).
        // Never let a diagnostics fetch failure skip the success analytics below
        // (getNativeBleConnectedDevice already swallows native errors → null, but
        // be explicit so analytics parity can't regress).
        const connectionDiagnostics = await getNativeBleConnectedDevice().catch(() => null);
        setBleDiagnosticsTags(connectionDiagnostics);
        // apiLevel is the level parseApiLevel actually picked; deviceNamePresent
        // records whether an advertised name was even available. parseApiLevel
        // silently defaults to v2 when the name is missing/unparseable, and v2
        // encoding drops LED positions > 1023 — so a v3 board connecting with no
        // advertised name would light only part of the wall. These two props let
        // us see in PostHog whether that fallback ever fires in the wild.
        track(SHARED_EVENTS.BluetoothConnectionSuccess, {
          boardName,
          layoutId,
          sizeId,
          apiLevel: apiLevelRef.current,
          deviceNamePresent: !!connection.deviceName,
          boardId: analyticsBoardId ?? undefined,
          connectedViaMismatchOverride: getConnectedViaMismatchOverride?.() ?? false,
          retry_succeeded: connection.retrySucceeded === true,
          bleChosenWriteType: connectionDiagnostics?.chosenWriteType,
          bleSupportsWithoutResponse: connectionDiagnostics?.supportsWriteWithoutResponse,
          bleCharProperties: connectionDiagnostics?.characteristicProperties,
          // Negotiated write lengths too, so a future MTU-related stall (vs a
          // write-type one) is visible in PostHog (see #3230).
          bleMaxWriteWithResponse: connectionDiagnostics?.maxWriteWithResponse,
          bleMaxWriteWithoutResponse: connectionDiagnostics?.maxWriteWithoutResponse,
          // Advertisement recon (parsed nowhere yet): newer bare-name boxes may
          // carry their serial / LED generation here instead of in the name.
          // Captured so we can find the layout across the fleet, then teach
          // parseSerialNumber/parseApiLevel to read it. Absent → fields dropped.
          bleManufacturerData: connection.manufacturerData ?? undefined,
          bleManufacturerCompanyId: manufacturerCompanyId(connection.manufacturerData),
          bleServiceData: connection.serviceData ? JSON.stringify(connection.serviceData) : undefined,
        });
        return true;
      } catch (error) {
        // Classify once, up front: it decides both whether this reaches error
        // tracking and the user copy below. A user dismissing the device picker
        // ('user_cancelled') isn't a failure — don't log it as one or report it.
        // board_not_found / connect_failed are environmental (board off, out of
        // range, GATT timeout), not app bugs, so they go in as warnings. Genuine
        // faults (unavailable / service_missing / unknown) stay at error level.
        const failureCategory = classifyBleFailure(error);
        const reportLevel = bleConnectReportLevel(failureCategory);
        if (reportLevel === null) {
          console.warn('Bluetooth device selection cancelled by user');
        } else {
          console.error('Error connecting to Bluetooth:', error);
          // For service_missing, tag the report with the services the board
          // actually exposed so the next occurrence is diagnosable: empty means
          // nothing was discovered (stale iOS GATT cache or a decoy peripheral),
          // unfamiliar UUIDs point at an unhandled controller generation (#3480).
          let discoveredServicesTag: string | undefined;
          if (failureCategory === 'service_missing') {
            const connectDiagnostics = await connectAdapter?.getLastConnectDiagnostics?.().catch(() => null);
            const discoveredServices = connectDiagnostics?.discoveredServices;
            if (discoveredServices) {
              discoveredServicesTag = discoveredServices.length > 0 ? discoveredServices.join(',') : 'none';
            }
          }
          reportHandledError(error, {
            level: reportLevel,
            tags: {
              source: 'ble-connect',
              failure_category: failureCategory,
              ...(discoveredServicesTag ? { ble_discovered_services: discoveredServicesTag } : {}),
            },
          });
        }
        setIsConnected(false);

        // Dismiss the picker sheet if it's still showing. When a reconnect-by-
        // serial grace window opens the picker but nothing ever advertises, the
        // adapter rejects the selection promise on the scan timeout without
        // settling the picker's own promise — so the sheet (and its spinner)
        // would otherwise stay mounted until the user swipes it away. Settle the
        // dangling picker promise before clearing it (matching the unmount
        // cleanup) so it can't leak.
        pickerRejectRef.current?.(new Error('Connection failed'));
        pickerRejectRef.current = null;
        setPickerState(null);

        // failureCategory (classified above) maps to actionable user copy via the
        // shared, deliberately-tight predicate. A previous bare `/cancel/i` regex
        // here also matched CoreBluetooth's "operation cancelled" / ble-plx's
        // "Operation was cancelled", so those real failures showed nothing — the
        // connect just looked like a dead tap. Only an explicit user-cancel stays
        // silent now. Literal-key switch (the i18n linter forbids `t(variable)`).
        switch (failureCategory) {
          case 'user_cancelled':
            break;
          case 'unavailable':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.unavailable'));
            break;
          case 'board_not_found':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.boardNotFound'));
            break;
          case 'service_missing':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.serviceMissing'));
            break;
          case 'connect_failed':
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.connectFailed'));
            break;
          default:
            Alert.alert(t('ble.connectionFailedTitle'), tCommon('bluetooth.unknownError'));
        }

        if (failureCategory !== 'user_cancelled') {
          track(SHARED_EVENTS.BluetoothConnectionFailed, {
            boardName,
            layoutId,
            sizeId,
            failureReason: failureCategory === 'unknown' ? classifyBleFailureReason(error) : failureCategory,
            // Raw ble-plx codes (Android) so the real connect-failure cause and the
            // low-level GATT status are visible for re-measurement (#3608). Empty on
            // web / native iOS.
            ...blePlxErrorCodes(error),
          });
        }
      } finally {
        connectInFlightRef.current = false;
        setLoading(false);
      }

      return false;
    },
    [
      handleDisconnection,
      beginConnectionLifetime,
      consumeConnectionLifetime,
      createConnectionHandle,
      boardName,
      layoutId,
      sizeId,
      setIds,
      boardUuid,
      analyticsBoardId,
      onConnectionChange,
      onConnectSuccess,
      getConnectedViaMismatchOverride,
      rememberConnectedBoard,
      sendFramesToBoard,
      sanitizedColorOverrides,
      moonboardLightAdjacentHolds,
      colorSignature,
      encodingSignature,
      writeActivityStore,
      devicePicker,
      t,
      tCommon,
    ],
  );

  const teardownConnection = useCallback(
    async (disconnectTrigger: Exclude<BleDisconnectTrigger, 'link_drop'>) => {
      // Suppress native-connection adoption until the next deliberate connect:
      // the native disconnect below is async, so a backgrounding/foregrounding
      // app could otherwise see getConnectedDevice still report the device this
      // teardown is closing and silently re-adopt it.
      adoptionSuppressedRef.current = true;
      unsubDisconnectRef.current?.();
      unsubDisconnectRef.current = null;
      const adapter = adapterRef.current;
      const lifetime = activeConnectionLifetimeRef.current;
      if (adapter && lifetime?.adapter === adapter) {
        consumeConnectionLifetime(adapter, lifetime.generation, 'user', disconnectTrigger);
      }
      adapterRef.current = null;
      configuredDeviceNameRef.current = undefined;
      connectedConfigIdentityRef.current = null;
      // Cancel every in-flight and queued write of this connection generation,
      // and unblock the write chain for the next connect.
      writeAbortRef.current?.abort();
      writeAbortRef.current = null;
      writeChainRef.current = Promise.resolve();
      writeActivityStore?.reset();
      setIsConnected(false);
      onConnectionChange?.(false);
      clearBleDiagnosticsTags();
      await adapter?.disconnect();
    },
    [consumeConnectionLifetime, onConnectionChange, writeActivityStore],
  );

  const disconnect = useCallback(
    async (reason: BluetoothDisconnectReason = 'user') => {
      // A deliberate disconnect forgets the board — only an involuntary drop or a
      // config switch keeps the silent same-board reconnect memory alive. Clears
      // the persisted copy too so the next launch doesn't resurrect it.
      // Auto-disconnect also keeps the remembered handle so the lightbulb can
      // silently reconnect to the same board.
      if (reason === 'user') forgetConnectedBoard();
      await teardownConnection(reason === 'user' ? 'explicit_user' : 'auto_disconnect');
    },
    [forgetConnectedBoard, teardownConnection],
  );

  // If the active board config changes while a connection is live, tear it down.
  // BluetoothProvider is mounted once globally; without this a board/layout/size/set
  // switch would keep the old physical link but encode sends with the NEW
  // config's LED placement map — wrong-format packets streamed to the OLD wall.
  useEffect(() => {
    const connectedIdentity = connectedConfigIdentityRef.current;
    if (!adapterRef.current || !connectedIdentity) return;
    const activeIdentity = connectionConfigIdentity(boardName, layoutId, sizeId, setIds);
    if (activeIdentity === connectedIdentity) return;
    // teardownConnection sets adoptionSuppressedRef on purpose: the named-device
    // adopt guard is boardType-granular only, so a same-family layout switch
    // (kilter/8/17 -> kilter/8/25) could otherwise race the async native
    // disconnect and re-adopt the old wall. A deliberate connect re-arms
    // adoption. lastConnectedBoard is PRESERVED so switching back offers a silent
    // reconnect (reconnectSerialForCurrentBoard self-guards on configKey).
    void teardownConnection('config_switch').catch(() => {});
    // isConnected is a dep so a config switch that lands while a connect is
    // still in flight (adapterRef not yet set when this effect last ran) is
    // re-checked the moment the connect completes and flips isConnected.
    // clearConnectionAfterDrop can also race here: if a native drop already
    // nulled adapterRef.current the early-return above prevents a double
    // teardown, which is intentional.
  }, [boardName, layoutId, sizeId, setIds, isConnected, teardownConnection]);

  // iOS-only: adopt a connection the native BoardBleManager established
  // outside JS — the Dynamic Island lightbulb's reconnect-by-last-known-board,
  // or CoreBluetooth state restoration after a relaunch. Without this the wall
  // re-lights (native drives it) but the in-app lightbulb stays dark and climb
  // navigation stops pushing until the user taps it again. Listens for the
  // bridged `connected` event and re-checks on foreground (events fired while
  // JS was suspended are missed). No-op on Android and on binaries older than
  // the `getConnectedDevice` surface.
  useEffect(() => {
    // A board native code can't drive (Woods) never rides the native adapter, so
    // there is no native connection to adopt — and no point building a throwaway
    // adapter just to learn that from isNativeIosBleAdapter below.
    if (!getBoardCapabilities(boardName).nativeBoardControl) return;
    const adopt = (deviceId: string, rawDeviceName?: string) => {
      // The bridge sends '' for a missing name — normalise so name parsing
      // (board type, serial, API level) sees undefined instead.
      const deviceName = rawDeviceName || undefined;
      // JS already has (or is establishing) its own adapter — nothing to adopt.
      if (adapterRef.current || connectInFlightRef.current) return;
      // The user explicitly disconnected; don't re-adopt the connection the
      // (possibly still in-flight) native disconnect is tearing down.
      if (adoptionSuppressedRef.current) return;
      if (!boardName || layoutId === undefined || sizeId === undefined) return;
      // Only adopt a device positively identified as the active config's board
      // type, or a nameless native reconnect for the exact config we most
      // recently paired. The latter covers CoreBluetooth retrieval/state
      // restoration paths that can become write-ready without a fresh
      // advertisement name.
      const adoptedBoardType = parseAnyBoardTypeFromDeviceName(deviceName);
      const currentConfigKey = boardConfigKey(boardName, layoutId, sizeId);
      const currentConnectionConfig = { boardName, layoutId, sizeId, setIds };
      const currentConnectionIdentity = connectionConfigIdentity(boardName, layoutId, sizeId, setIds);
      const rememberedBoard = lastConnectedBoardRef.current;
      const canAdoptNamelessRememberedBoard = !adoptedBoardType && rememberedBoard?.configKey === currentConfigKey;
      if (
        (!adoptedBoardType && !canAdoptNamelessRememberedBoard) ||
        (adoptedBoardType && adoptedBoardType !== boardName)
      ) {
        return;
      }

      const adapter = createBluetoothAdapter(
        devicePicker,
        scanFamilyForBoard(boardName),
        adapterOptionsForBoard(boardName),
      );
      if (!isNativeIosBleAdapter(adapter) || typeof adapter.configureBoard !== 'function') return;
      adapter.adoptConnection(deviceId);
      apiLevelRef.current = parseApiLevel(deviceName);
      configuredDeviceNameRef.current = deviceName;
      const connectionGeneration = nextConnectionGenerationRef.current + 1;
      nextConnectionGenerationRef.current = connectionGeneration;
      adapterRef.current = adapter;
      connectedConfigIdentityRef.current = currentConnectionIdentity;
      unsubDisconnectRef.current = adapter.onDisconnect((info) => {
        handleDisconnection(adapter, connectionGeneration, info);
      });
      beginConnectionLifetime(adapter, connectionGeneration, currentConnectionIdentity);
      const connectionHandle = createConnectionHandle(
        adapter,
        connectionGeneration,
        currentConnectionIdentity,
        currentConnectionConfig,
        parseAnyBoardTypeFromDeviceName(deviceName),
      );
      void adapter
        .configureBoard({
          boardName,
          layoutId,
          sizeId,
          apiLevel: apiLevelRef.current,
          deviceName,
          colorOverrides: sanitizedColorOverrides,
          numRows: moonboardNumRowsForNative(boardName, layoutId),
          lightAdjacentHolds: moonboardLightAdjacentHolds,
        })
        .catch(() => {});

      const serial = deviceName ? (parseSerialNumber(deviceName) ?? null) : (rememberedBoard?.serial ?? null);
      if (serial) {
        rememberConnectedBoard({ configKey: currentConfigKey, serial });
      } else if (boardName === 'moonboard') {
        rememberConnectedBoard({ configKey: currentConfigKey, deviceId });
      }
      setIsConnected(true);
      onConnectionChange?.(true);
      onConnectSuccess?.(serial, connectionHandle);
      // Surface this adopted connection's write diagnostics to Sentry too
      // (widget reconnect / state restoration paths, not just JS connect).
      // Fire-and-forget; a native rejection is intentionally ignored.
      void getNativeBleConnectedDevice()
        .then(setBleDiagnosticsTags)
        .catch(() => {});
    };

    const connectedSubscription = subscribeNativeBleConnected((payload) => {
      adopt(payload.deviceId, payload.deviceName);
    });
    // null = platform/binary without the adoption surface — nothing to do.
    if (!connectedSubscription) return;

    // The subscriptions are removed in the cleanup, but an in-flight
    // getConnectedDevice promise can't be cancelled — without this flag it
    // would adopt (create an adapter, setState) after the effect was torn
    // down by an unmount or a config change.
    let cancelled = false;
    const checkNativeConnection = () => {
      void getNativeBleConnectedDevice().then((device) => {
        if (cancelled) return;
        if (device) adopt(device.deviceId, device.name);
      });
    };

    checkNativeConnection();
    const appStateSubscription = AppState.addEventListener('change', (appState) => {
      if (appState === 'active') checkNativeConnection();
    });

    return () => {
      cancelled = true;
      connectedSubscription.remove();
      appStateSubscription.remove();
    };
  }, [
    boardName,
    beginConnectionLifetime,
    createConnectionHandle,
    layoutId,
    sizeId,
    setIds,
    devicePicker,
    handleDisconnection,
    onConnectionChange,
    onConnectSuccess,
    rememberConnectedBoard,
    sanitizedColorOverrides,
    moonboardLightAdjacentHolds,
  ]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !isNativeIosBleAdapter(adapter) || typeof adapter.configureBoard !== 'function' || !isConnected) {
      return;
    }
    if (!boardName || layoutId === undefined || sizeId === undefined) return;
    void adapter
      .configureBoard({
        boardName,
        layoutId,
        sizeId,
        apiLevel: apiLevelRef.current,
        deviceName: configuredDeviceNameRef.current,
        colorOverrides: sanitizedColorOverrides,
        numRows: moonboardNumRowsForNative(boardName, layoutId),
        lightAdjacentHolds: moonboardLightAdjacentHolds,
      })
      .catch(() => {});
  }, [boardName, layoutId, sizeId, isConnected, sanitizedColorOverrides, moonboardLightAdjacentHolds]);

  // Serial to silently reconnect to for the board currently in view, or null
  // when nothing is remembered or the user switched boards (in which case the
  // caller opens the device picker instead).
  //
  // Deliberately keyed on board+layout+size only — NOT set_ids, which the tracked
  // connection identity above does include. Reconnect targeting identifies the
  // same physical controller and the LED placement map keys on layout+size; the
  // lifetime still ends on a set-only route switch so attribution cannot bleed.
  const currentConfigKey =
    boardName && layoutId !== undefined && sizeId !== undefined ? boardConfigKey(boardName, layoutId, sizeId) : null;
  // The remembered board only counts while the route still points at the same
  // config; a stored handle for a different board is never offered as a target.
  const rememberedForCurrentBoard =
    lastConnectedBoard && currentConfigKey && lastConnectedBoard.configKey === currentConfigKey
      ? lastConnectedBoard
      : null;
  // Aurora reconnects by serial; MoonBoard (no serial) reconnects by BLE device
  // id. The lightbulb passes whichever is set so the tap silently reconnects to
  // the same board instead of dropping the user into the picker.
  const reconnectSerialForCurrentBoard = rememberedForCurrentBoard?.serial ?? null;
  const reconnectDeviceIdForCurrentBoard = rememberedForCurrentBoard?.deviceId ?? null;

  // Rehydrate the remembered board from storage on mount so a one-tap silent
  // reconnect survives a cold start / provider remount, not just the in-memory
  // session (#3609). A live connect that lands during the async read wins — only
  // seed when nothing has been remembered yet. reconnectSerialForCurrentBoard
  // self-guards on configKey, so a stored board for a different config is simply
  // never offered as a reconnect target. This only sets the target for a user
  // tap; it never auto-connects, so the no-auto-reconnect policy is untouched.
  useEffect(() => {
    let cancelled = false;
    void getStoredLastConnectedBoard().then((stored) => {
      if (cancelled || !stored) return;
      if (lastConnectedBoardRef.current) return;
      setLastConnectedBoard(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Reject with the explicit user-cancel signature so a connect that's
      // still awaiting the picker classifies as `user_cancelled` (silent)
      // rather than popping an alert over whatever screen comes next.
      pickerRejectRef.current?.(new Error('Device selection cancelled'));
      pickerRejectRef.current = null;
      unsubDisconnectRef.current?.();
      unsubDisconnectRef.current = null;
      writeAbortRef.current?.abort();
      writeActivityStore?.reset();
      const adapter = adapterRef.current;
      const lifetime = activeConnectionLifetimeRef.current;
      if (adapter && lifetime?.adapter === adapter) {
        // A provider unmount is component teardown, not an observed BLE end:
        // its analytics/presence callback owners are unmounting too. Ordinary
        // navigation keeps this global provider mounted, while user-triggered
        // disconnects go through teardownConnection and do notify. Consume this
        // lifetime silently so the native disconnect callback cannot emit it
        // later after the subscription and owners are gone.
        consumeConnectionLifetime(adapter, lifetime.generation, 'user', 'explicit_user', undefined, false);
      }
      adapterRef.current = null;
      void adapter?.disconnect();
    };
  }, [consumeConnectionLifetime, writeActivityStore]);

  return {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    pickerState,
    reconnectSerialForCurrentBoard,
    reconnectDeviceIdForCurrentBoard,
    connectInitialSendRef,
  };
}
