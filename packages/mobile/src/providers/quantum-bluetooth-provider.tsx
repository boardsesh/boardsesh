import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useBoardPresenceActions } from '@boardsesh/board-presence-react';
import { MAX_DIODES_PER_LAYER, type InstallationBoardLayer } from '@boardsesh/board-layers';
import { QUANTUM_MODELS } from '@boardsesh/board-constants/quantum';
import type {
  QuantumBoardModelId,
  QuantumControllerMetadata,
  QuantumRosterSnapshot,
} from '@boardsesh/ble-protocol/quantum';
import { DevicePickerSheet } from '../components/ble/DevicePickerSheet';
import { registerBluetoothConnection } from '../lib/ble/bluetooth-status-store';
import { requestBleRuntimePermissions } from '../lib/ble/use-ble-permissions';
import { createQuantumBluetoothTransport } from '../lib/ble/quantum-adapter';
import { getOrCreateQuantumLayerIdentities } from '../lib/ble/quantum-layer-identity-store';
import { sanitizeQuantumRosterForPresence, type ResolvedQuantumRoutePresence } from '../lib/ble/quantum-presence';
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
import { buildQuantumClimbLightTarget } from '../lib/ble/quantum-climb-lights';
import { reportHandledError } from '../lib/error-reporting';
import { getQuantumGeometry } from '../lib/quantum-geometry-store';
import { useBoardPresenceControls } from './board-presence-provider';
import { useQueueActions } from './queue-provider';

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
  layers: readonly InstallationBoardLayer[];
  lastError: Error | null;
};

export type QuantumActivateLayerInput = {
  slot: number;
  controllerRouteUuid: string;
  diodeIds: readonly number[];
  durationSeconds?: number;
  animation?: number;
  /** Display-safe presence metadata. The controller route UUID itself never
   * crosses the board-presence or analytics boundary. */
  climbUuid?: string | null;
  angle?: number | null;
  geometryKnown: true;
};

export type QuantumRemoveLayerInput = {
  slot: number;
  controllerRouteUuid: string;
};

export type QuantumBluetoothActions = {
  connect(targetSerial?: string, targetDeviceId?: string): Promise<boolean>;
  disconnect(): Promise<void>;
  refresh(): Promise<QuantumRosterSnapshot | null>;
  activateLayer(input: QuantumActivateLayerInput): Promise<QuantumRosterSnapshot>;
  removeLayer(input: QuantumRemoveLayerInput): Promise<QuantumRosterSnapshot>;
  clearAll(input: { confirmed: boolean }): Promise<QuantumRosterSnapshot>;
};

const QuantumBluetoothStateContext = createContext<QuantumBluetoothState | null>(null);
const QuantumBluetoothActionsContext = createContext<QuantumBluetoothActions | null>(null);

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

function colorNumber(layer: InstallationBoardLayer): number {
  return (layer.color.red << 16) | (layer.color.green << 8) | layer.color.blue;
}

function requireLayer(layers: readonly InstallationBoardLayer[], slot: number): InstallationBoardLayer {
  const layer = layers.find((candidate) => candidate.slot === slot);
  if (!layer) throw new Error(`Quantum layer slot ${slot} is unavailable`);
  return layer;
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

function resolvePresenceClimb(
  climb: QuantumPresenceClimb,
  modelId: QuantumBoardModelId,
): readonly [string, ResolvedQuantumRoutePresence] | null {
  const selectedModel = QUANTUM_MODELS[modelId];
  const controllerRouteUuid = climb.controllerRouteUuid?.toLowerCase();
  if (!controllerRouteUuid || climb.boardType !== 'quantum' || climb.layoutId !== selectedModel.layoutId) {
    return null;
  }
  const lightTarget = buildQuantumClimbLightTarget(
    climb,
    getQuantumGeometry(selectedModel.layoutId, selectedModel.sizeId),
    selectedModel.layoutId,
  );
  if (!lightTarget.ok && ['wrong-board', 'wrong-layout', 'missing-route'].includes(lightTarget.reason)) return null;
  return [
    controllerRouteUuid,
    {
      climbUuid: climb.uuid,
      angle: climb.angle,
      geometryKnown: lightTarget.ok,
    },
  ];
}

async function recoverRoutePresence(
  snapshot: QuantumRosterSnapshot,
  modelId: QuantumBoardModelId,
  resolvedRoutes: ReadonlyMap<string, ResolvedQuantumRoutePresence>,
  queueClimbs: readonly QuantumPresenceClimb[],
): Promise<ReadonlyMap<string, ResolvedQuantumRoutePresence>> {
  const activeRouteUuids = new Set(snapshot.players.map((player) => player.routeId.toLowerCase()));
  const recoveredRoutes = new Map<string, ResolvedQuantumRoutePresence>();
  for (const queueClimb of queueClimbs) {
    const resolvedClimb = resolvePresenceClimb(queueClimb, modelId);
    if (!resolvedClimb || !activeRouteUuids.has(resolvedClimb[0])) continue;
    recoveredRoutes.set(...resolvedClimb);
  }
  const routeUuids = [...activeRouteUuids].filter(
    (routeUuid) => resolvedRoutes.get(routeUuid)?.geometryKnown !== true && !recoveredRoutes.has(routeUuid),
  );
  const database = getDatabaseHandle();
  if (!database || routeUuids.length === 0) return recoveredRoutes;

  const selectedModel = QUANTUM_MODELS[modelId];
  try {
    const localClimbs = await getQuantumRoutePresenceClimbsLocal(database, selectedModel.layoutId, routeUuids);
    for (const localClimb of localClimbs) {
      const resolvedClimb = resolvePresenceClimb(
        { ...localClimb, boardType: 'quantum', layoutId: selectedModel.layoutId },
        modelId,
      );
      if (resolvedClimb && !recoveredRoutes.has(resolvedClimb[0])) recoveredRoutes.set(...resolvedClimb);
    }
    return recoveredRoutes;
  } catch (error) {
    reportHandledError(error, {
      tags: { source: 'quantum-presence', operation: 'recover-local-roster' },
    });
    return recoveredRoutes;
  }
}

function applyRecoveredRoutePresence(
  snapshot: QuantumRosterSnapshot,
  recoveredRoutes: ReadonlyMap<string, ResolvedQuantumRoutePresence>,
  resolvedRoutes: Map<string, ResolvedQuantumRoutePresence>,
): void {
  const activeRouteUuids = new Set(snapshot.players.map((player) => player.routeId.toLowerCase()));
  for (const routeUuid of resolvedRoutes.keys()) {
    if (!activeRouteUuids.has(routeUuid)) resolvedRoutes.delete(routeUuid);
  }
  for (const [routeUuid, recoveredRoute] of recoveredRoutes) {
    if (resolvedRoutes.get(routeUuid)?.geometryKnown === true) continue;
    resolvedRoutes.set(routeUuid, recoveredRoute);
  }
}

export function QuantumBluetoothProvider({
  selectedModelId,
  preferredSerial,
  children,
}: {
  selectedModelId: QuantumBoardModelId | null;
  preferredSerial?: string | null;
  children: ReactNode;
}) {
  const { reportLayers } = useBoardPresenceActions();
  const presenceControls = useBoardPresenceControls();
  const { getQueueSnapshot } = useQueueActions();
  const [status, setStatus] = useState<QuantumBluetoothStatus>(selectedModelId ? 'disconnected' : 'inactive');
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<QuantumControllerConnection | null>(null);
  const [roster, setRoster] = useState<QuantumRosterSnapshot | null>(null);
  const [layers, setLayers] = useState<readonly InstallationBoardLayer[]>([]);
  const [lastError, setLastError] = useState<Error | null>(null);
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const selectedModelIdRef = useRef(selectedModelId);
  selectedModelIdRef.current = selectedModelId;
  const preferredSerialRef = useRef(preferredSerial);
  preferredSerialRef.current = preferredSerial;
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const transportRef = useRef<QuantumBluetoothTransport | null>(null);
  const controllerRef = useRef<QuantumBoardController | null>(null);
  const removeControllerListenerRef = useRef<(() => void) | null>(null);
  const removeDisconnectListenerRef = useRef<(() => void) | null>(null);
  const connectPromiseRef = useRef<Promise<boolean> | null>(null);
  const connectionOwnerSequenceRef = useRef(0);
  const activeConnectionOwnerRef = useRef<number | null>(null);
  const previousModelIdRef = useRef<QuantumBoardModelId | null>(selectedModelId);
  const resolvedRoutePresenceRef = useRef(new Map<string, ResolvedQuantumRoutePresence>());
  const boundPresenceBoardIdRef = useRef<number | null>(null);
  const activePresenceConnectionRef = useRef<ActivePresenceConnection | null>(null);
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
        if (activePresenceConnectionRef.current?.generation !== connection.generation) return;
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
        transportRef.current === transport &&
        controllerRef.current === controller;
      let presenceSnapshot = initialSnapshot;

      for (let recoveryAttempt = 0; recoveryAttempt < QUANTUM_PRESENCE_RECOVERY_ATTEMPTS; recoveryAttempt += 1) {
        const queueSnapshot = getQueueSnapshot();
        const recoveredRoutes = await recoverRoutePresence(
          presenceSnapshot,
          modelId,
          resolvedRoutePresenceRef.current,
          [
            ...queueSnapshot.queue.map((queueItem) => queueItem.climb),
            ...(queueSnapshot.currentClimbQueueItem ? [queueSnapshot.currentClimbQueueItem.climb] : []),
          ],
        );
        if (!connectionIsCurrent()) return false;
        const latestSnapshot = controller.snapshot;
        if (!latestSnapshot) return false;
        if (latestSnapshot.revision !== presenceSnapshot.revision) {
          presenceSnapshot = latestSnapshot;
          continue;
        }
        applyRecoveredRoutePresence(presenceSnapshot, recoveredRoutes, resolvedRoutePresenceRef.current);
        reportConfirmedRoster(presenceSnapshot, presenceConnection);
        return true;
      }

      if (!connectionIsCurrent()) return false;
      const latestSnapshot = controller.snapshot;
      if (!latestSnapshot) return false;
      // Constant controller churn must not leave the wall unclaimed. Report the
      // exact latest roster with existing mappings; unknown routes fail closed
      // to null/geometryKnown=false and self-heal on the next refresh.
      reportConfirmedRoster(latestSnapshot, presenceConnection);
      return true;
    },
    [getQueueSnapshot, reportConfirmedRoster],
  );

  const disconnectPresence = useCallback(async () => {
    const connection = activePresenceConnectionRef.current;
    // Invalidate before awaiting: queued reports from this link drop, while an
    // already-running report remains ahead of the disconnect in the same lane.
    presenceGenerationRef.current += 1;
    activePresenceConnectionRef.current = null;
    boundPresenceBoardIdRef.current = null;
    resolvedRoutePresenceRef.current.clear();
    presenceControlsRef.current.resetPresence();
    const boardId = connection?.boardId;
    if (boardId !== null && boardId !== undefined) {
      await enqueuePresenceWrite(() => presenceControlsRef.current.reportDisconnectForBoard(boardId));
    }
  }, [enqueuePresenceWrite]);

  const devicePicker = useCallback<DevicePickerFn>((subscribe) => {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let devices: PickerState['devices'] = [];
      const finish = (result: { deviceId: string } | { error: Error }) => {
        if (settled) return;
        settled = true;
        setPickerState(null);
        if ('deviceId' in result) resolve(result.deviceId);
        else reject(result.error);
      };
      const update = (nextDevices: PickerState['devices']) => {
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
      const stopScanning = () => setPickerState((current) => (current ? { ...current, isScanning: false } : current));
      subscribe(update, stopScanning);
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

  const disconnect = useCallback(async () => {
    // Status belongs to the owner being detached, so update it before a slow
    // native disconnect can overlap a later connect request.
    setStatus(selectedModelIdRef.current ? 'disconnected' : 'inactive');
    setLastError(null);
    await disposeConnection();
  }, [disposeConnection]);

  const connect = useCallback<QuantumBluetoothActions['connect']>(
    (targetSerial, targetDeviceId) => {
      if (connectPromiseRef.current) return connectPromiseRef.current;
      const operation = (async () => {
        const modelId = selectedModelIdRef.current;
        if (!modelId) return false;
        setStatus('connecting');
        setLastError(null);

        try {
          const permissionsGranted = await requestBleRuntimePermissions();
          if (!permissionsGranted) throw new Error('Bluetooth permission was not granted');
          const resolvedLayers = await getOrCreateQuantumLayerIdentities();
          layersRef.current = resolvedLayers;
          setLayers(resolvedLayers);

          await disposeConnection();
          const transport = createQuantumBluetoothTransport(devicePicker);
          const connectionOwner = ++connectionOwnerSequenceRef.current;
          activeConnectionOwnerRef.current = connectionOwner;
          transportRef.current = transport;
          const connected = await transport.requestAndConnect(
            modelId,
            targetSerial ?? preferredSerialRef.current ?? undefined,
            targetDeviceId,
          );
          if (
            selectedModelIdRef.current !== modelId ||
            activeConnectionOwnerRef.current !== connectionOwner ||
            transportRef.current !== transport
          ) {
            await disposeConnection({ expectedOwner: connectionOwner });
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
          const binding = await presenceControlsRef.current.resolveAndBindBoard({
            serial: connected.serial,
            boardType: 'quantum',
            layoutId: selectedModel.layoutId,
            sizeId: selectedModel.sizeId,
            setIds: '1',
          });
          if (
            selectedModelIdRef.current !== modelId ||
            activeConnectionOwnerRef.current !== connectionOwner ||
            transportRef.current !== transport
          ) {
            await disposeConnection({ expectedOwner: connectionOwner });
            return false;
          }
          const presenceConnection: ActivePresenceConnection = {
            generation: ++presenceGenerationRef.current,
            boardId: binding?.boardId ?? null,
          };
          activePresenceConnectionRef.current = presenceConnection;
          boundPresenceBoardIdRef.current = presenceConnection.boardId;
          const initialSnapshot = await controller.refresh();
          if (
            activePresenceConnectionRef.current?.generation !== presenceConnection.generation ||
            activeConnectionOwnerRef.current !== connectionOwner ||
            transportRef.current !== transport
          ) {
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
          if (!rosterReported) return false;
          setStatus('connected');
          return true;
        } catch (error) {
          await disposeConnection();
          const normalized = error instanceof Error ? error : new Error('Quantum controller connection failed');
          setLastError(normalized);
          setStatus(selectedModelIdRef.current ? 'disconnected' : 'inactive');
          return false;
        }
      })().finally(() => {
        connectPromiseRef.current = null;
      });
      connectPromiseRef.current = operation;
      return operation;
    },
    [devicePicker, disposeConnection, recoverAndReportRoster],
  );

  const refresh = useCallback<QuantumBluetoothActions['refresh']>(async () => {
    const controller = controllerRef.current;
    if (!controller) return null;
    const presenceConnection = activePresenceConnectionRef.current;
    const connectionOwner = activeConnectionOwnerRef.current;
    const modelId = selectedModelIdRef.current;
    try {
      const snapshot = await controller.refresh();
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
      setLastError(normalized);
      throw normalized;
    }
  }, [recoverAndReportRoster]);

  const activateLayer = useCallback<QuantumBluetoothActions['activateLayer']>(
    async (input) => {
      try {
        const controller = controllerRef.current;
        if (!controller) throw new Error('Quantum controller is not connected');
        const presenceConnection = activePresenceConnectionRef.current;
        const layer = requireLayer(layersRef.current, input.slot);
        const snapshot = await controller.activate({
          routeId: input.controllerRouteUuid,
          userId: layer.controllerUserUuid,
          diodeIds: validateDiodeIds(input.diodeIds),
          color: colorNumber(layer),
          durationSeconds: input.durationSeconds,
          animation: input.animation,
        });
        if (presenceConnection && activePresenceConnectionRef.current?.generation === presenceConnection.generation) {
          resolvedRoutePresenceRef.current.set(input.controllerRouteUuid.toLowerCase(), {
            climbUuid: input.climbUuid ?? null,
            angle: input.angle ?? null,
            geometryKnown: input.geometryKnown,
          });
        }
        setLastError(null);
        reportConfirmedRoster(snapshot, presenceConnection);
        return snapshot;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error('Quantum layer activation failed');
        setLastError(normalized);
        throw normalized;
      }
    },
    [reportConfirmedRoster],
  );

  const removeLayer = useCallback<QuantumBluetoothActions['removeLayer']>(
    async (input) => {
      try {
        const controller = controllerRef.current;
        if (!controller) throw new Error('Quantum controller is not connected');
        const presenceConnection = activePresenceConnectionRef.current;
        const layer = requireLayer(layersRef.current, input.slot);
        const snapshot = await controller.remove({
          userId: layer.controllerUserUuid,
          routeId: input.controllerRouteUuid,
        });
        if (presenceConnection && activePresenceConnectionRef.current?.generation === presenceConnection.generation) {
          resolvedRoutePresenceRef.current.delete(input.controllerRouteUuid.toLowerCase());
        }
        setLastError(null);
        reportConfirmedRoster(snapshot, presenceConnection);
        return snapshot;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error('Quantum layer removal failed');
        setLastError(normalized);
        throw normalized;
      }
    },
    [reportConfirmedRoster],
  );

  const clearAll = useCallback<QuantumBluetoothActions['clearAll']>(
    async (input) => {
      try {
        const controller = controllerRef.current;
        if (!controller) throw new Error('Quantum controller is not connected');
        const presenceConnection = activePresenceConnectionRef.current;
        const snapshot = await controller.clearAll(input);
        if (presenceConnection && activePresenceConnectionRef.current?.generation === presenceConnection.generation) {
          resolvedRoutePresenceRef.current.clear();
        }
        setLastError(null);
        reportConfirmedRoster(snapshot, presenceConnection);
        return snapshot;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error('Quantum wall clear failed');
        setLastError(normalized);
        throw normalized;
      }
    },
    [reportConfirmedRoster],
  );

  useEffect(() => {
    let cancelled = false;
    const modelChanged = previousModelIdRef.current !== selectedModelId;
    if (modelChanged) {
      previousModelIdRef.current = selectedModelId;
      // Keep the externally observed state internally consistent in the same
      // render: teardown awaits the native disconnect, but a disconnected model
      // must never retain a connection/roster from the previous controller.
      setStatus(selectedModelId ? 'disconnected' : 'inactive');
      setConnection(null);
      setRoster(null);
      resolvedRoutePresenceRef.current.clear();
      if (transportRef.current) void disposeConnection().catch(() => {});
    }
    if (!selectedModelId) {
      setIsAvailable(null);
      setStatus('inactive');
      void disposeConnection().catch(() => {});
      return;
    }

    if (!modelChanged) setStatus((current) => (current === 'inactive' ? 'disconnected' : current));
    const probe = createQuantumBluetoothTransport(devicePicker);
    void probe.isAvailable().then((available) => {
      if (!cancelled) setIsAvailable(available);
    });
    void getOrCreateQuantumLayerIdentities().then((resolvedLayers) => {
      if (!cancelled) setLayers(resolvedLayers);
    });
    return () => {
      cancelled = true;
    };
  }, [devicePicker, disposeConnection, selectedModelId]);

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

  useEffect(
    () => () => {
      void disposeConnection().catch(() => {});
    },
    [disposeConnection],
  );

  const state = useMemo<QuantumBluetoothState>(
    () => ({
      status,
      isAvailable,
      connection,
      metadata: connection?.metadata ?? null,
      roster,
      layers,
      lastError,
    }),
    [connection, isAvailable, lastError, layers, roster, status],
  );
  const actions = useMemo<QuantumBluetoothActions>(
    () => ({ connect, disconnect, refresh, activateLayer, removeLayer, clearAll }),
    [activateLayer, clearAll, connect, disconnect, refresh, removeLayer],
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

export function useQuantumBluetoothState(): QuantumBluetoothState {
  const state = useContext(QuantumBluetoothStateContext);
  if (!state) throw new Error('useQuantumBluetoothState must be used within QuantumBluetoothProvider');
  return state;
}

export function useQuantumBluetoothActions(): QuantumBluetoothActions {
  const actions = useContext(QuantumBluetoothActionsContext);
  if (!actions) throw new Error('useQuantumBluetoothActions must be used within QuantumBluetoothProvider');
  return actions;
}

/** Non-throwing reads let shared chrome keep working before the wrapper mounts,
 * and let tests or utility surfaces render without Quantum support. */
export function useOptionalQuantumBluetoothState(): QuantumBluetoothState | null {
  return useContext(QuantumBluetoothStateContext);
}

export function useOptionalQuantumBluetoothActions(): QuantumBluetoothActions | null {
  return useContext(QuantumBluetoothActionsContext);
}
