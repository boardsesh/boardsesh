import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useBoardPresenceActions } from '@boardsesh/board-presence-react';
import { BOARD_LAYER_COLORS, MAX_DIODES_PER_LAYER } from '@boardsesh/board-layers';
import { QUANTUM_MODELS, QUANTUM_RELEASED_MODELS } from '@boardsesh/board-constants/quantum';
import {
  encodeQuantumActivation,
  quantumUuidsEqual,
  QuantumRosterTransactionError,
  type QuantumBoardModelId,
  type QuantumControllerMetadata,
  type QuantumRosterSnapshot,
} from '@boardsesh/ble-protocol/quantum';
import { DevicePickerSheet } from '../components/ble/DevicePickerSheet';
import { registerBluetoothConnection } from '../lib/ble/bluetooth-status-store';
import { requestBleRuntimePermissions } from '../lib/ble/use-ble-permissions';
import { createQuantumBluetoothTransport } from '../lib/ble/quantum-adapter';
import {
  getOrCreateQuantumSoloPlayer,
  getQuantumSessionPlayer,
  type QuantumLocalPlayer,
} from '../lib/ble/quantum-layer-identity-store';
import { getStoredCreatedSessionId } from '../lib/session-store';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../lib/privacy/privacy-cache';
import {
  isQuantumRoutePresenceOwnerCurrent,
  sanitizeQuantumRosterForPresence,
  type ResolvedQuantumRoutePresence,
} from '../lib/ble/quantum-presence';
import {
  QuantumBoardController,
  type QuantumBluetoothTransport,
  type QuantumControllerConnection,
} from '../lib/ble/quantum-transport';
import type { PickerState } from '../lib/ble/use-board-bluetooth';
import type { DevicePickerFn } from '../lib/ble/types';
import type { BleBoardConfig } from '../lib/ble/board-config-match';
import { getDatabaseHandle } from '../db';
import { getQuantumRoutePresenceClimbsLocal } from '../db/queries/quantum-route-presence-local';
import { isQuantumClimbRetired } from '../db/queries/quantum-climb-retirement';
import {
  assessQuantumActivationSafety,
  quantumLayerColorNumber,
  buildQuantumClimbLightTarget,
  resolveQuantumPlacementDiodes,
} from '../lib/ble/quantum-climb-lights';
import { reportHandledError } from '../lib/error-reporting';
import {
  getQuantumGeometry,
  getQuantumGeometryGeneration,
  type QuantumGeometryRegistration,
} from '../lib/quantum-geometry-store';
import { useBoardPresenceControls } from './board-presence-provider';

const QUANTUM_ROSTER_POLL_INTERVAL_MS = 10_000;
const QUANTUM_PRESENCE_RECOVERY_ATTEMPTS = 3;
const EMPTY_RESOLVED_BOARDS = new Map();

type ActivePresenceConnection = {
  generation: number;
  boardId: number | null;
};

type DisposeConnectionOptions = {
  expectedOwner?: number;
  disconnectTransport?: boolean;
};

export type QuantumBluetoothStatus = 'inactive' | 'disconnected' | 'connecting' | 'connected';

export type QuantumBluetoothState = {
  status: QuantumBluetoothStatus;
  isAvailable: boolean | null;
  connection: QuantumControllerConnection | null;
  metadata: QuantumControllerMetadata | null;
  roster: QuantumRosterSnapshot | null;
  player: QuantumLocalPlayer | null;
  driverStatus: 'checking' | 'available' | 'peer' | 'unavailable';
  lastError: Error | null;
};

export type QuantumActivateLayerInput = {
  slot: number;
  controllerRouteUuid: string;
  expectedOwnedRouteUuid?: string;
  diodeIds: readonly number[];
  placementIds: readonly number[];
  layoutId: number;
  sizeId: number;
  geometryGeneration: number;
  durationSeconds?: number;
  animation?: number;
  /** Display-safe presence metadata. The controller route UUID itself never
   * crosses the board-presence or analytics boundary. */
  climbUuid?: string | null;
  angle?: number | null;
  geometryKnown: true;
};

export type QuantumRemoveLayerInput = {
  controllerUserUuid: string;
  controllerRouteUuid: string;
};

export type QuantumBluetoothActions = {
  connect(targetSerial?: string, targetDeviceId?: string): Promise<boolean>;
  disconnect(): Promise<void>;
  refresh(): Promise<QuantumRosterSnapshot | null>;
  activateLayer(input: QuantumActivateLayerInput): Promise<QuantumRosterSnapshot>;
  removeLayer(input: QuantumRemoveLayerInput): Promise<QuantumRosterSnapshot>;
};

import { QuantumBluetoothStateContext, QuantumBluetoothActionsContext } from './quantum-bluetooth-context';
export {
  useQuantumBluetoothState,
  useQuantumBluetoothActions,
  useOptionalQuantumBluetoothState,
  useOptionalQuantumBluetoothActions,
} from './quantum-bluetooth-context';

function modelPickerConfig(modelId: QuantumBoardModelId | null): BleBoardConfig | undefined {
  if (!modelId) return undefined;
  const model = QUANTUM_MODELS[modelId];
  return {
    boardName: 'quantum',
    layoutId: model.layoutId,
    sizeId: model.sizeId,
    setIds: '1',
  };
}

function validateDiodeIds(diodeIds: readonly number[]): number[] {
  const uniqueDiodeIds = [...new Set(diodeIds)];
  if (uniqueDiodeIds.length !== diodeIds.length) throw new Error('Quantum layer diode ids must be unique');
  if (uniqueDiodeIds.length === 0 || uniqueDiodeIds.length > MAX_DIODES_PER_LAYER) {
    throw new Error(`Quantum layers require 1 to ${MAX_DIODES_PER_LAYER} unique diodes`);
  }
  return uniqueDiodeIds;
}

type QuantumPresenceClimb = Parameters<typeof buildQuantumClimbLightTarget>[0];
type LocalResolvedQuantumRoutePresence = ResolvedQuantumRoutePresence & {
  /** Local-only safety data. sanitizeQuantumRosterForPresence reconstructs the
   * wire shape and never forwards diode addresses to presence or analytics. */
  diodeIds: readonly number[] | null;
  /** Null means the diode set was physically confirmed by this app. Recovered
   * mappings carry the geometry generation that produced them. */
  geometryGeneration: number | null;
};

function resolvePresenceClimb(
  climb: QuantumPresenceClimb,
  modelId: QuantumBoardModelId,
  geometry: QuantumGeometryRegistration | null,
  geometryGeneration: number | null,
): readonly [string, LocalResolvedQuantumRoutePresence] | null {
  const selectedModel = QUANTUM_MODELS[modelId];
  const controllerRouteUuid = climb.controllerRouteUuid?.toLowerCase();
  if (!controllerRouteUuid || climb.boardType !== 'quantum' || climb.layoutId !== selectedModel.layoutId) {
    return null;
  }
  const lightTarget = buildQuantumClimbLightTarget(climb, geometry, selectedModel.layoutId, geometryGeneration);
  if (!lightTarget.ok && ['wrong-board', 'wrong-layout', 'wrong-size', 'missing-route'].includes(lightTarget.reason))
    return null;
  return [
    controllerRouteUuid,
    {
      climbUuid: climb.uuid,
      angle: climb.angle,
      geometryKnown: lightTarget.ok,
      diodeIds: lightTarget.ok ? lightTarget.target.diodeIds : null,
      geometryGeneration,
    },
  ];
}

type QuantumRouteRecoveryResult = {
  routes: ReadonlyMap<string, LocalResolvedQuantumRoutePresence>;
  geometryGeneration: number | null;
};

function hasPhysicallyConfirmedGeometry(route: LocalResolvedQuantumRoutePresence | undefined): boolean {
  return route?.geometryKnown === true && route.geometryGeneration === null && !!route.controllerUserUuid;
}

async function recoverRoutePresence(
  snapshot: QuantumRosterSnapshot,
  modelId: QuantumBoardModelId,
  resolvedRoutes: ReadonlyMap<string, LocalResolvedQuantumRoutePresence>,
): Promise<QuantumRouteRecoveryResult> {
  const selectedModel = QUANTUM_MODELS[modelId];
  const geometry = getQuantumGeometry(selectedModel.layoutId, selectedModel.sizeId);
  const geometryGeneration = getQuantumGeometryGeneration(selectedModel.layoutId, selectedModel.sizeId);
  const activeRouteUuids = new Set(snapshot.players.map((player) => player.routeId.toLowerCase()));
  const recoveredRoutes = new Map<string, LocalResolvedQuantumRoutePresence>();
  // Queue and climb caches without explicit provenance may hold a later edit
  // under the same controller UUID. Only physical write confirmations survive
  // without rechecking the downloaded, source-owned catalogue rows.
  const routeUuids = [...activeRouteUuids].filter((routeUuid) => {
    const resolvedRoute = resolvedRoutes.get(routeUuid);
    return (
      !resolvedRoute ||
      !hasPhysicallyConfirmedGeometry(resolvedRoute) ||
      !isQuantumRoutePresenceOwnerCurrent(snapshot, routeUuid, resolvedRoute)
    );
  });
  const database = getDatabaseHandle();
  if (!database || routeUuids.length === 0) return { routes: recoveredRoutes, geometryGeneration };

  try {
    const localClimbs = await getQuantumRoutePresenceClimbsLocal(
      database,
      selectedModel.layoutId,
      selectedModel.sizeId,
      routeUuids,
    );
    for (const localClimb of localClimbs) {
      const resolvedClimb = resolvePresenceClimb(
        { ...localClimb, boardType: 'quantum', layoutId: selectedModel.layoutId },
        modelId,
        geometry,
        geometryGeneration,
      );
      if (!resolvedClimb) continue;
      const recoveredRoute = recoveredRoutes.get(resolvedClimb[0]);
      if (!recoveredRoute || (recoveredRoute.geometryKnown !== true && resolvedClimb[1].geometryKnown)) {
        recoveredRoutes.set(...resolvedClimb);
      }
    }
    return { routes: recoveredRoutes, geometryGeneration };
  } catch (error) {
    reportHandledError(error, {
      tags: { source: 'quantum-presence', operation: 'recover-local-roster' },
    });
    return { routes: recoveredRoutes, geometryGeneration };
  }
}

function pruneResolvedRoutePresence(
  snapshot: QuantumRosterSnapshot,
  resolvedRoutes: Map<string, LocalResolvedQuantumRoutePresence>,
  geometryGeneration: number | null,
): void {
  const activeRouteUuids = new Set(snapshot.players.map((player) => player.routeId.toLowerCase()));
  for (const [routeUuid, resolvedRoute] of resolvedRoutes) {
    if (
      !activeRouteUuids.has(routeUuid) ||
      !isQuantumRoutePresenceOwnerCurrent(snapshot, routeUuid, resolvedRoute) ||
      (resolvedRoute.geometryGeneration !== null && resolvedRoute.geometryGeneration !== geometryGeneration)
    ) {
      resolvedRoutes.delete(routeUuid);
    }
  }
}

function applyRecoveredRoutePresence(
  snapshot: QuantumRosterSnapshot,
  recoveredRoutes: ReadonlyMap<string, LocalResolvedQuantumRoutePresence>,
  resolvedRoutes: Map<string, LocalResolvedQuantumRoutePresence>,
  geometryGeneration: number | null,
): void {
  pruneResolvedRoutePresence(snapshot, resolvedRoutes, geometryGeneration);
  for (const [routeUuid, previousRoute] of resolvedRoutes) {
    if (!hasPhysicallyConfirmedGeometry(previousRoute) && !recoveredRoutes.has(routeUuid)) {
      resolvedRoutes.delete(routeUuid);
    }
  }
  for (const [routeUuid, recoveredRoute] of recoveredRoutes) {
    if (hasPhysicallyConfirmedGeometry(resolvedRoutes.get(routeUuid))) continue;
    resolvedRoutes.set(routeUuid, recoveredRoute);
  }
}

export function QuantumBluetoothProvider({
  selectedModelId: candidateModelId,
  selectedBoardUuid,
  preferredSerial,
  sessionId = null,
  accountId = null,
  sessionContextReady = true,
  getCurrentSessionId,
  isSelectionIntentCurrent,
  children,
}: {
  selectedModelId: QuantumBoardModelId | null;
  selectedBoardUuid?: string | null;
  preferredSerial?: string | null;
  sessionId?: string | null;
  accountId?: string | null;
  sessionContextReady?: boolean;
  getCurrentSessionId?: () => string | null;
  isSelectionIntentCurrent?: () => boolean;
  children: ReactNode;
}) {
  const selectedModelId = QUANTUM_RELEASED_MODELS.find((modelId) => modelId === candidateModelId) ?? null;
  const credentialGeneration = useSyncExternalStore(
    subscribeToCredentialChanges,
    getCredentialGeneration,
    getCredentialGeneration,
  );
  const { reportLayers } = useBoardPresenceActions();
  const presenceControls = useBoardPresenceControls();
  const [status, setStatus] = useState<QuantumBluetoothStatus>(selectedModelId ? 'disconnected' : 'inactive');
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<QuantumControllerConnection | null>(null);
  const [roster, setRoster] = useState<QuantumRosterSnapshot | null>(null);
  const [lastError, setLastError] = useState<Error | null>(null);
  const [pickerState, setPickerState] = useState<Pick<
    PickerState,
    'devices' | 'isScanning' | 'handleSelect' | 'handleCancel'
  > | null>(null);
  const cancelActivePickerRef = useRef<((error: Error) => void) | null>(null);
  const mountedRef = useRef(true);
  const attemptGenerationRef = useRef(0);
  // A new selection gets a distinct token even when it returns to the
  // same board/session after a flag toggle. Old callbacks retain their token.
  const selectionIdentity = useMemo(
    () => ({
      modelId: selectedModelId,
      selectedBoardUuid,
      preferredSerial,
      sessionId,
      accountId,
      sessionContextReady,
      credentialGeneration,
    }),
    [
      selectedModelId,
      selectedBoardUuid,
      preferredSerial,
      sessionId,
      accountId,
      sessionContextReady,
      credentialGeneration,
    ],
  );
  const selectionIdentityRef = useRef(selectionIdentity);
  selectionIdentityRef.current = selectionIdentity;
  const activeConnectionIdentityRef = useRef<typeof selectionIdentity | null>(null);
  const isSelectionCurrent = useCallback(
    () =>
      mountedRef.current &&
      selectionIdentityRef.current === selectionIdentity &&
      credentialGeneration === getCredentialGeneration() &&
      (getCurrentSessionId === undefined || getCurrentSessionId() === sessionId),
    [credentialGeneration, getCurrentSessionId, selectionIdentity, sessionId],
  );
  const [playerResolution, setPlayerResolution] = useState<{
    scope: typeof selectionIdentity;
    player: QuantumLocalPlayer | null;
  } | null>(null);
  const playerResolutionRef = useRef(playerResolution);
  const resolvePlayer = useCallback(async () => {
    if (!sessionId) return getOrCreateQuantumSoloPlayer();
    if (!accountId || (await getStoredCreatedSessionId()) !== sessionId) return null;
    return getQuantumSessionPlayer({ sessionId, accountId });
  }, [accountId, sessionId]);
  const publishPlayerResolution = useCallback(
    (player: QuantumLocalPlayer | null) => {
      if (!isSelectionCurrent()) return;
      const resolution = { scope: selectionIdentity, player };
      playerResolutionRef.current = resolution;
      setPlayerResolution(resolution);
    },
    [isSelectionCurrent, selectionIdentity],
  );
  const selectedModelIdRef = useRef(selectedModelId);
  selectedModelIdRef.current = selectedModelId;
  const selectedBoardUuidRef = useRef(selectedBoardUuid);
  selectedBoardUuidRef.current = selectedBoardUuid;
  const preferredSerialRef = useRef(preferredSerial);
  preferredSerialRef.current = preferredSerial;
  const transportRef = useRef<QuantumBluetoothTransport | null>(null);
  const controllerRef = useRef<QuantumBoardController | null>(null);
  const removeControllerListenerRef = useRef<(() => void) | null>(null);
  const removeDisconnectListenerRef = useRef<(() => void) | null>(null);
  const connectPromiseRef = useRef<Promise<boolean> | null>(null);
  const connectionOwnerSequenceRef = useRef(0);
  const activeConnectionOwnerRef = useRef<number | null>(null);
  const previousSelectionIdentityRef = useRef(selectionIdentity);
  const resolvedRoutePresenceRef = useRef(new Map<string, LocalResolvedQuantumRoutePresence>());
  const boundPresenceBoardIdRef = useRef<number | null>(null);
  const activePresenceConnectionRef = useRef<ActivePresenceConnection | null>(null);
  const ownsPresenceBindingRef = useRef(false);
  const presenceGenerationRef = useRef(0);
  const presenceWriteTailRef = useRef<Promise<void>>(Promise.resolve());
  const reportLayersRef = useRef(reportLayers);
  reportLayersRef.current = reportLayers;
  const presenceControlsRef = useRef(presenceControls);
  presenceControlsRef.current = presenceControls;

  const enqueuePresenceWrite = useCallback((write: () => Promise<unknown>): Promise<void> => {
    const queued = presenceWriteTailRef.current.then(async () => {
      await write();
    });
    // A presence failure must not wedge subsequent disconnect/report writes.
    presenceWriteTailRef.current = queued.catch(() => {});
    return queued.catch(() => {});
  }, []);

  const reportConfirmedRoster = useCallback(
    (snapshot: QuantumRosterSnapshot, connection: ActivePresenceConnection | null) => {
      if (!connection) return;
      // This is the only server boundary for controller state. It intentionally
      // reconstructs a fresh display-safe object and never spreads a controller
      // player, so controller user/route UUIDs cannot leak into GraphQL.
      const sanitized = sanitizeQuantumRosterForPresence(snapshot, resolvedRoutePresenceRef.current);
      void enqueuePresenceWrite(async () => {
        if (
          activePresenceConnectionRef.current?.generation !== connection.generation ||
          activeConnectionIdentityRef.current !== selectionIdentityRef.current
        )
          return;
        if (connection.boardId !== null) {
          await presenceControlsRef.current.reportLayersForBoard(connection.boardId, sanitized);
        } else {
          await reportLayersRef.current(sanitized);
        }
      });
    },
    [enqueuePresenceWrite],
  );

  const recoverAndReportRoster = useCallback(
    async ({
      controller,
      initialSnapshot,
      modelId,
      presenceConnection,
      connectionOwner,
      transport,
    }: {
      controller: QuantumBoardController;
      initialSnapshot: QuantumRosterSnapshot;
      modelId: QuantumBoardModelId;
      presenceConnection: ActivePresenceConnection;
      connectionOwner: number;
      transport: QuantumBluetoothTransport;
    }): Promise<boolean> => {
      const connectionIsCurrent = () =>
        activePresenceConnectionRef.current?.generation === presenceConnection.generation &&
        activeConnectionOwnerRef.current === connectionOwner &&
        selectedModelIdRef.current === modelId &&
        activeConnectionIdentityRef.current === selectionIdentityRef.current &&
        transportRef.current === transport &&
        controllerRef.current === controller;
      let presenceSnapshot = initialSnapshot;

      for (let recoveryAttempt = 0; recoveryAttempt < QUANTUM_PRESENCE_RECOVERY_ATTEMPTS; recoveryAttempt += 1) {
        const recovery = await recoverRoutePresence(presenceSnapshot, modelId, resolvedRoutePresenceRef.current);
        if (!connectionIsCurrent()) return false;
        const latestSnapshot = controller.snapshot;
        if (!latestSnapshot) return false;
        if (latestSnapshot.revision !== presenceSnapshot.revision) {
          presenceSnapshot = latestSnapshot;
          continue;
        }
        const selectedModel = QUANTUM_MODELS[modelId];
        if (
          getQuantumGeometryGeneration(selectedModel.layoutId, selectedModel.sizeId) !== recovery.geometryGeneration
        ) {
          presenceSnapshot = latestSnapshot;
          continue;
        }
        applyRecoveredRoutePresence(
          presenceSnapshot,
          recovery.routes,
          resolvedRoutePresenceRef.current,
          recovery.geometryGeneration,
        );
        reportConfirmedRoster(presenceSnapshot, presenceConnection);
        return true;
      }

      if (!connectionIsCurrent()) return false;
      const latestSnapshot = controller.snapshot;
      if (!latestSnapshot) return false;
      // Constant controller churn must not leave the wall unclaimed. Report the
      // exact latest roster with existing mappings; unknown routes fail closed
      // to null/geometryKnown=false and self-heal on the next refresh.
      const selectedModel = QUANTUM_MODELS[modelId];
      pruneResolvedRoutePresence(
        latestSnapshot,
        resolvedRoutePresenceRef.current,
        getQuantumGeometryGeneration(selectedModel.layoutId, selectedModel.sizeId),
      );
      reportConfirmedRoster(latestSnapshot, presenceConnection);
      return true;
    },
    [reportConfirmedRoster],
  );

  const disconnectPresence = useCallback(async () => {
    const connection = activePresenceConnectionRef.current;
    const ownedPresence = ownsPresenceBindingRef.current;
    ownsPresenceBindingRef.current = false;
    // Invalidate before awaiting: queued reports from this link drop, while an
    // already-running report remains ahead of the disconnect in the same lane.
    presenceGenerationRef.current += 1;
    activePresenceConnectionRef.current = null;
    boundPresenceBoardIdRef.current = null;
    resolvedRoutePresenceRef.current.clear();
    if (ownedPresence) presenceControlsRef.current.resetPresence();
    const boardId = connection?.boardId;
    if (boardId !== null && boardId !== undefined) {
      await enqueuePresenceWrite(() => presenceControlsRef.current.reportDisconnectForBoard(boardId));
    }
  }, [enqueuePresenceWrite]);

  const devicePicker = useCallback<DevicePickerFn>((subscribe, _targetSearch, signal) => {
    return new Promise<string>((resolve, reject) => {
      cancelActivePickerRef.current?.(new Error('Device selection superseded'));
      let settled = false;
      let devices: PickerState['devices'] = [];
      function finish(result: { deviceId: string } | { error: Error }) {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', handleAbort);
        if (cancelActivePickerRef.current === cancel) {
          cancelActivePickerRef.current = null;
          setPickerState(null);
        }
        if ('deviceId' in result) resolve(result.deviceId);
        else reject(result.error);
      }
      function cancel(error: Error) {
        finish({ error });
      }
      function handleAbort() {
        const reason = signal?.reason;
        cancel(reason instanceof Error ? reason : new Error('Device selection cancelled'));
      }
      cancelActivePickerRef.current = cancel;
      if (signal?.aborted) {
        handleAbort();
        return;
      }
      signal?.addEventListener('abort', handleAbort, { once: true });
      const update = (nextDevices: PickerState['devices']) => {
        if (settled || cancelActivePickerRef.current !== cancel) return;
        devices = nextDevices;
        setPickerState((current) =>
          current
            ? { ...current, devices: nextDevices }
            : {
                devices: nextDevices,
                isScanning: true,
                handleSelect: (deviceId) => finish({ deviceId }),
                handleCancel: () => finish({ error: new Error('Device selection cancelled') }),
              },
        );
      };
      const stopScanning = () => {
        if (settled || cancelActivePickerRef.current !== cancel) return;
        setPickerState((current) => (current ? { ...current, isScanning: false } : current));
      };
      try {
        subscribe(update, stopScanning);
      } catch (error) {
        cancel(error instanceof Error ? error : new Error('Device selection failed'));
        return;
      }
      if (settled || cancelActivePickerRef.current !== cancel) return;
      setPickerState({
        devices,
        isScanning: true,
        handleSelect: (deviceId) => finish({ deviceId }),
        handleCancel: () => finish({ error: new Error('Device selection cancelled') }),
      });
    });
  }, []);

  const disposeConnection = useCallback(
    async (options: DisposeConnectionOptions = {}): Promise<boolean> => {
      const owner = activeConnectionOwnerRef.current;
      if (options.expectedOwner !== undefined && owner !== options.expectedOwner) return false;

      // Detach owner-sensitive resources before awaiting native teardown. A
      // replacement connection may start while an old vendor stack is still
      // resolving disconnect(); that late completion must have no work left that
      // can clear the replacement's state or presence binding.
      activeConnectionOwnerRef.current = null;
      activeConnectionIdentityRef.current = null;
      removeControllerListenerRef.current?.();
      removeControllerListenerRef.current = null;
      removeDisconnectListenerRef.current?.();
      removeDisconnectListenerRef.current = null;
      controllerRef.current?.destroy();
      controllerRef.current = null;
      const transport = transportRef.current;
      transportRef.current = null;
      setConnection(null);
      setRoster(null);
      const presenceDisconnect = disconnectPresence();
      try {
        if (transport && options.disconnectTransport !== false) await transport.disconnect();
      } finally {
        await presenceDisconnect;
      }
      return true;
    },
    [disconnectPresence],
  );

  const invalidateConnectionAttempt = useCallback(() => {
    attemptGenerationRef.current += 1;
    connectPromiseRef.current = null;
    cancelActivePickerRef.current?.(new Error('Quantum connection attempt cancelled'));
  }, []);

  const disconnect = useCallback(async () => {
    invalidateConnectionAttempt();
    // Status belongs to the owner being detached, so update it before a slow
    // native disconnect can overlap a later connect request.
    setStatus(selectedModelIdRef.current ? 'disconnected' : 'inactive');
    setLastError(null);
    await disposeConnection();
  }, [disposeConnection, invalidateConnectionAttempt]);

  const connect = useCallback<QuantumBluetoothActions['connect']>(
    (targetSerial, targetDeviceId) => {
      if (!selectedModelId || !sessionContextReady || !isSelectionCurrent() || isSelectionIntentCurrent?.() === false)
        return Promise.resolve(false);
      if (connectPromiseRef.current) return connectPromiseRef.current;
      if (activeConnectionIdentityRef.current === selectionIdentity && controllerRef.current) {
        return Promise.resolve(false);
      }
      const attemptGeneration = ++attemptGenerationRef.current;
      const connectionOwner = ++connectionOwnerSequenceRef.current;
      const attemptIdentity = selectionIdentity;
      const attemptBoardUuid = selectedBoardUuidRef.current;
      const attemptIsCurrent = () =>
        attemptGenerationRef.current === attemptGeneration &&
        isSelectionCurrent() &&
        isSelectionIntentCurrent?.() !== false;
      const operation = (async () => {
        const modelId = selectedModelId;
        const loaded = playerResolutionRef.current;
        if (sessionId && (loaded?.scope !== attemptIdentity || !loaded.player)) return false;
        if (!attemptIsCurrent()) return false;
        setStatus('connecting');
        setLastError(null);

        try {
          const permissionsGranted = await requestBleRuntimePermissions();
          if (!attemptIsCurrent()) return false;
          if (!permissionsGranted) throw new Error('Bluetooth permission was not granted');
          const player = loaded?.scope === attemptIdentity ? loaded.player : await resolvePlayer();
          if (!attemptIsCurrent()) return false;
          if (!player) throw new Error('This phone cannot drive the Quantum wall');
          publishPlayerResolution(player);

          await disposeConnection();
          if (!attemptIsCurrent()) return false;
          const transport = createQuantumBluetoothTransport(devicePicker);
          activeConnectionOwnerRef.current = connectionOwner;
          activeConnectionIdentityRef.current = attemptIdentity;
          transportRef.current = transport;
          const disposeStaleAttempt = async () => {
            const disposed = await disposeConnection({ expectedOwner: connectionOwner });
            // A model change may already have detached this owner before the
            // chooser/GATT promise resolves. Retire the old transport directly
            // so its late physical link cannot survive owner-aware cleanup.
            if (!disposed) await transport.disconnect().catch(() => {});
          };
          const connected = await transport.requestAndConnect(
            modelId,
            targetSerial ?? preferredSerialRef.current ?? undefined,
            targetDeviceId,
          );
          if (
            !attemptIsCurrent() ||
            selectedModelIdRef.current !== modelId ||
            activeConnectionOwnerRef.current !== connectionOwner ||
            transportRef.current !== transport
          ) {
            await disposeStaleAttempt();
            return false;
          }

          const controller = new QuantumBoardController(transport);
          controllerRef.current = controller;
          removeControllerListenerRef.current = controller.subscribe(setRoster);
          removeDisconnectListenerRef.current = transport.onDisconnect((info) => {
            if (activeConnectionOwnerRef.current !== connectionOwner) return;
            setStatus('disconnected');
            setLastError(new Error(info?.description ?? 'Quantum controller disconnected'));
            void disposeConnection({ expectedOwner: connectionOwner, disconnectTransport: false });
          });
          setConnection(connected);
          const selectedModel = QUANTUM_MODELS[modelId];
          ownsPresenceBindingRef.current = true;
          const binding = await presenceControlsRef.current.resolveAndBindBoard({
            serial: connected.serial,
            boardType: 'quantum',
            layoutId: selectedModel.layoutId,
            sizeId: selectedModel.sizeId,
            setIds: '1',
            ...(attemptBoardUuid ? { selectedBoardUuid: attemptBoardUuid } : {}),
          });
          if (
            !attemptIsCurrent() ||
            selectedModelIdRef.current !== modelId ||
            activeConnectionOwnerRef.current !== connectionOwner ||
            transportRef.current !== transport
          ) {
            await disposeStaleAttempt();
            return false;
          }
          const presenceConnection: ActivePresenceConnection = {
            generation: ++presenceGenerationRef.current,
            boardId: binding?.boardId ?? null,
          };
          activePresenceConnectionRef.current = presenceConnection;
          boundPresenceBoardIdRef.current = presenceConnection.boardId;
          const initialSnapshot = await controller.refresh(attemptIsCurrent);
          if (
            !attemptIsCurrent() ||
            activePresenceConnectionRef.current?.generation !== presenceConnection.generation ||
            activeConnectionOwnerRef.current !== connectionOwner ||
            transportRef.current !== transport
          ) {
            await disposeStaleAttempt();
            return false;
          }
          const rosterReported = await recoverAndReportRoster({
            controller,
            initialSnapshot,
            modelId,
            presenceConnection,
            connectionOwner,
            transport,
          });
          if (!attemptIsCurrent() || !rosterReported) {
            await disposeStaleAttempt();
            return false;
          }
          setStatus('connected');
          return true;
        } catch (error) {
          if (!attemptIsCurrent()) return false;
          await disposeConnection();
          if (!attemptIsCurrent()) return false;
          const normalized = error instanceof Error ? error : new Error('Quantum controller connection failed');
          setLastError(normalized);
          setStatus(selectedModelIdRef.current ? 'disconnected' : 'inactive');
          return false;
        }
      })().finally(() => {
        if (connectPromiseRef.current === operation) connectPromiseRef.current = null;
      });
      connectPromiseRef.current = operation;
      return operation;
    },
    [
      devicePicker,
      disposeConnection,
      isSelectionIntentCurrent,
      isSelectionCurrent,
      publishPlayerResolution,
      recoverAndReportRoster,
      resolvePlayer,
      selectedModelId,
      selectionIdentity,
      sessionContextReady,
      sessionId,
    ],
  );

  // A rendered action belongs to the controller link shown in that render.
  // Check that link again in the GATT lane, immediately before each write.
  const actionConnectionOwner = status === 'connected' ? activeConnectionOwnerRef.current : null;
  const canUseConnection = useCallback(
    () =>
      actionConnectionOwner !== null &&
      activeConnectionOwnerRef.current === actionConnectionOwner &&
      activeConnectionIdentityRef.current === selectionIdentity &&
      isSelectionCurrent() &&
      isSelectionIntentCurrent?.() !== false,
    [actionConnectionOwner, isSelectionIntentCurrent, isSelectionCurrent, selectionIdentity],
  );
  const requireCurrentPlayer = useCallback(() => {
    const resolution = playerResolutionRef.current;
    if (!canUseConnection() || resolution?.scope !== selectionIdentity || !resolution.player) {
      throw new Error('Quantum controller is not connected for this phone');
    }
    return resolution.player;
  }, [canUseConnection, selectionIdentity]);

  const refresh = useCallback<QuantumBluetoothActions['refresh']>(async () => {
    const controller = controllerRef.current;
    if (!controller || !canUseConnection()) return null;
    const presenceConnection = activePresenceConnectionRef.current;
    const connectionOwner = activeConnectionOwnerRef.current;
    const modelId = selectedModelIdRef.current;
    try {
      const snapshot = await controller.refresh(canUseConnection);
      if (!canUseConnection()) return null;
      const transport = transportRef.current;
      if (modelId && presenceConnection && connectionOwner !== null && transport) {
        await recoverAndReportRoster({
          controller,
          initialSnapshot: snapshot,
          modelId,
          presenceConnection,
          connectionOwner,
          transport,
        });
      }
      setLastError(null);
      return controller.snapshot ?? snapshot;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error('Quantum roster refresh failed');
      if (canUseConnection()) setLastError(normalized);
      throw normalized;
    }
  }, [canUseConnection, recoverAndReportRoster]);

  const activateLayer = useCallback<QuantumBluetoothActions['activateLayer']>(
    async (input) => {
      try {
        const player = requireCurrentPlayer();
        const controller = controllerRef.current;
        if (!controller) throw new Error('Quantum controller is not connected');
        const presenceConnection = activePresenceConnectionRef.current;
        const connectionOwner = activeConnectionOwnerRef.current;
        const modelId = selectedModelIdRef.current;
        const transport = transportRef.current;
        if (!presenceConnection || connectionOwner === null || !modelId || !transport) {
          throw new Error('Quantum controller presence is not ready');
        }
        const selectedModel = QUANTUM_MODELS[modelId];
        if (input.layoutId !== selectedModel.layoutId || input.sizeId !== selectedModel.sizeId) {
          throw new Error('Quantum climb target belongs to a different board model');
        }
        const color = BOARD_LAYER_COLORS[input.slot];
        if (!color) throw new Error('Quantum layer color is unavailable');
        const requestedDiodeIds = validateDiodeIds(input.diodeIds);
        const activation = {
          routeId: input.controllerRouteUuid,
          userId: player.controllerUserUuid,
          diodeIds: requestedDiodeIds,
          color: quantumLayerColorNumber(color),
          durationSeconds: input.durationSeconds,
          animation: input.animation,
        };
        // Validate the complete command before even asking the wall for a roster.
        encodeQuantumActivation(activation);
        const climbUuid = input.climbUuid;
        const assertTargetAvailable = climbUuid
          ? async () => {
              if (await isQuantumClimbRetired(climbUuid)) {
                throw new QuantumRosterTransactionError(
                  'target-unavailable',
                  'This Quantum climb is no longer available to light',
                );
              }
            }
          : undefined;
        if (assertTargetAvailable) await assertTargetAvailable();
        if (!canUseConnection()) throw new Error('Quantum controller connection changed during activation preflight');
        const preflightSnapshot = await controller.refresh(canUseConnection);
        if (!canUseConnection()) throw new Error('Quantum controller connection changed during activation preflight');
        const rosterRecovered = await recoverAndReportRoster({
          controller,
          initialSnapshot: preflightSnapshot,
          modelId,
          presenceConnection,
          connectionOwner,
          transport,
        });
        if (
          !rosterRecovered ||
          !canUseConnection() ||
          controllerRef.current !== controller ||
          activeConnectionOwnerRef.current !== connectionOwner ||
          activePresenceConnectionRef.current?.generation !== presenceConnection.generation ||
          selectedModelIdRef.current !== modelId ||
          transportRef.current !== transport
        ) {
          throw new Error('Quantum controller connection changed during activation preflight');
        }
        const confirmedSnapshot = controller.snapshot;
        if (!confirmedSnapshot) throw new Error('Quantum controller roster is unavailable');
        if (
          confirmedSnapshot.players.some(
            (activePlayer) =>
              quantumUuidsEqual(activePlayer.routeId, input.controllerRouteUuid) &&
              !quantumUuidsEqual(activePlayer.userId, player.controllerUserUuid),
          )
        ) {
          throw new Error('Quantum route is already active on another layer');
        }
        const currentGeometryGeneration = getQuantumGeometryGeneration(selectedModel.layoutId, selectedModel.sizeId);
        const currentGeometry = getQuantumGeometry(selectedModel.layoutId, selectedModel.sizeId);
        let diodeIds: number[];
        if (currentGeometryGeneration === input.geometryGeneration) {
          diodeIds = requestedDiodeIds;
        } else {
          const revalidatedTarget = resolveQuantumPlacementDiodes(
            input.placementIds,
            currentGeometry,
            selectedModel.layoutId,
          );
          if (!revalidatedTarget.ok || currentGeometryGeneration === null) {
            throw new Error('Quantum climb geometry changed and can no longer be resolved');
          }
          diodeIds = validateDiodeIds(revalidatedTarget.diodeIds);
        }
        // If geometry changed after async roster recovery, discard every
        // geometry-derived foreign mapping. Locally confirmed physical diode
        // sets carry a null generation and remain authoritative.
        pruneResolvedRoutePresence(confirmedSnapshot, resolvedRoutePresenceRef.current, currentGeometryGeneration);
        const resolvedDiodesByRoute = new Map<string, readonly number[] | null>(
          [...resolvedRoutePresenceRef.current].map(
            ([routeUuid, resolvedRoute]) => [routeUuid, resolvedRoute.diodeIds] as const,
          ),
        );
        const safety = assessQuantumActivationSafety(
          confirmedSnapshot.players,
          player.controllerUserUuid,
          diodeIds,
          resolvedDiodesByRoute,
        );
        if (!safety.ok) {
          throw new Error(
            safety.reason === 'diode-overlap'
              ? 'Quantum climb overlaps an active layer'
              : 'Quantum wall has an active route whose diode geometry is unavailable',
          );
        }
        const snapshot = await controller.activate({
          ...activation,
          diodeIds,
          ...(input.expectedOwnedRouteUuid !== undefined ? { expectedOwnedRouteId: input.expectedOwnedRouteUuid } : {}),
          expectedPlayers: confirmedSnapshot.players,
          isEligible: canUseConnection,
          ...(assertTargetAvailable ? { assertTargetAvailable } : {}),
        });
        if (!canUseConnection()) return snapshot;
        if (activePresenceConnectionRef.current?.generation === presenceConnection.generation) {
          resolvedRoutePresenceRef.current.set(input.controllerRouteUuid.toLowerCase(), {
            climbUuid: input.climbUuid ?? null,
            angle: input.angle ?? null,
            geometryKnown: input.geometryKnown,
            diodeIds,
            geometryGeneration: null,
            controllerUserUuid: player.controllerUserUuid,
          });
        }
        setLastError(null);
        reportConfirmedRoster(snapshot, presenceConnection);
        return snapshot;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error('Quantum layer activation failed');
        if (canUseConnection()) setLastError(normalized);
        throw normalized;
      }
    },
    [canUseConnection, recoverAndReportRoster, reportConfirmedRoster, requireCurrentPlayer],
  );

  const removeLayer = useCallback<QuantumBluetoothActions['removeLayer']>(
    async (input) => {
      try {
        const player = requireCurrentPlayer();
        const controller = controllerRef.current;
        if (!controller) throw new Error('Quantum controller is not connected');
        if (!quantumUuidsEqual(player.controllerUserUuid, input.controllerUserUuid)) {
          throw new Error('This phone does not own the requested Quantum layer');
        }

        const presenceConnection = activePresenceConnectionRef.current;
        const snapshot = await controller.remove({
          userId: player.controllerUserUuid,
          routeId: input.controllerRouteUuid,
          isEligible: canUseConnection,
        });
        if (!canUseConnection()) return snapshot;
        if (presenceConnection && activePresenceConnectionRef.current?.generation === presenceConnection.generation) {
          resolvedRoutePresenceRef.current.delete(input.controllerRouteUuid.toLowerCase());
        }
        setLastError(null);
        reportConfirmedRoster(snapshot, presenceConnection);
        return snapshot;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error('Quantum layer removal failed');
        if (canUseConnection()) setLastError(normalized);
        throw normalized;
      }
    },
    [canUseConnection, reportConfirmedRoster, requireCurrentPlayer],
  );

  useEffect(() => {
    let cancelled = false;
    const selectionChanged = previousSelectionIdentityRef.current !== selectionIdentity;
    if (selectionChanged) {
      previousSelectionIdentityRef.current = selectionIdentity;
      invalidateConnectionAttempt();
      // Keep the externally observed state internally consistent in the same
      // render: teardown awaits the native disconnect, but a disconnected model
      // must never retain a connection/roster from the previous controller.
      setStatus(selectedModelId ? 'disconnected' : 'inactive');
      setConnection(null);
      setRoster(null);
      resolvedRoutePresenceRef.current.clear();
      if (transportRef.current || activeConnectionOwnerRef.current !== null || ownsPresenceBindingRef.current)
        void disposeConnection().catch(() => {});
    }
    if (!selectedModelId) {
      setIsAvailable(null);
      setStatus('inactive');
      return;
    }

    if (!selectionChanged) setStatus((current) => (current === 'inactive' ? 'disconnected' : current));
    const probe = createQuantumBluetoothTransport(devicePicker);
    void probe.isAvailable().then((available) => {
      if (!cancelled) setIsAvailable(available);
    });
    if (sessionContextReady) {
      void resolvePlayer().then(
        (player) => {
          if (!cancelled) publishPlayerResolution(player);
        },
        () => {
          if (!cancelled) publishPlayerResolution(null);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [
    devicePicker,
    disposeConnection,
    invalidateConnectionAttempt,
    publishPlayerResolution,
    resolvePlayer,
    selectedModelId,
    selectionIdentity,
    sessionContextReady,
  ]);

  useEffect(() => {
    if (status !== 'connected') return;
    const poll = () => {
      if (AppState.currentState === 'active') void refresh().catch(() => {});
    };
    const intervalId = setInterval(poll, QUANTUM_ROSTER_POLL_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh().catch(() => {});
    });
    return () => {
      clearInterval(intervalId);
      subscription.remove();
    };
  }, [refresh, status]);

  useEffect(() => {
    if (status !== 'connected') return;
    return registerBluetoothConnection(() => {
      void disconnect();
    });
  }, [disconnect, status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateConnectionAttempt();
      if (transportRef.current || activeConnectionOwnerRef.current !== null || ownsPresenceBindingRef.current)
        void disposeConnection().catch(() => {});
    };
  }, [disposeConnection, invalidateConnectionAttempt]);

  const playerResolutionCurrent = playerResolution?.scope === selectionIdentity;
  const player = playerResolutionCurrent ? playerResolution.player : null;
  const driverStatus = playerResolutionCurrent
    ? player
      ? 'available'
      : sessionId
        ? 'peer'
        : 'unavailable'
    : 'checking';
  const currentLink = activeConnectionIdentityRef.current === selectionIdentity;
  const currentStatus = selectedModelId
    ? currentLink
      ? status
      : status === 'connecting' && connectPromiseRef.current
        ? 'connecting'
        : 'disconnected'
    : 'inactive';
  const state = useMemo<QuantumBluetoothState>(
    () => ({
      status: currentStatus,
      isAvailable,
      connection: currentLink ? connection : null,
      metadata: currentLink ? (connection?.metadata ?? null) : null,
      roster: currentLink ? roster : null,
      player,
      driverStatus,
      lastError,
    }),
    [connection, currentLink, currentStatus, driverStatus, isAvailable, lastError, player, roster],
  );
  const actions = useMemo<QuantumBluetoothActions>(
    () => ({ connect, disconnect, refresh, activateLayer, removeLayer }),
    [activateLayer, connect, disconnect, refresh, removeLayer],
  );
  const pickerConfig = useMemo(() => modelPickerConfig(selectedModelId), [selectedModelId]);

  return (
    <QuantumBluetoothActionsContext.Provider value={actions}>
      <QuantumBluetoothStateContext.Provider value={state}>{children}</QuantumBluetoothStateContext.Provider>
      {pickerState ? (
        <DevicePickerSheet
          devices={pickerState.devices}
          onSelect={pickerState.handleSelect}
          onDismiss={pickerState.handleCancel}
          isScanning={pickerState.isScanning}
          resolvedBoards={EMPTY_RESOLVED_BOARDS}
          currentBoardConfig={pickerConfig}
        />
      ) : null}
    </QuantumBluetoothActionsContext.Provider>
  );
}
