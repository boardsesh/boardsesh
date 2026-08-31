// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevicePickerFn } from '../../lib/ble/types';

const ROUTE_UUID = '10000000-0000-4000-8000-000000000001';
const ACTIVE_ROUTE_UUID = '10000000-0000-4000-8000-000000000002';
const CONTROLLER_USER_UUID = '20000000-0000-4000-8000-000000000001';

type TestRosterSnapshot = {
  revision: number;
  observedAtMs: number;
  players: Array<{
    routeId: string;
    userId: string;
    remainingSeconds: number;
    color: number;
  }>;
};

type TestTransportConnection = {
  deviceId: string;
  deviceName: string;
  serial: string;
  metadata: {
    model: {
      id: 'xl' | 'l';
      displayName: string;
      controllerType: number;
      columns: number;
      rows: number;
    };
    controllerType: number;
    columns: number;
    rows: number;
  };
};

const controller = vi.hoisted(() => ({
  initialSnapshot: {
    revision: 1,
    observedAtMs: 1_000,
    players: [
      {
        routeId: '10000000-0000-4000-8000-000000000099',
        userId: '20000000-0000-4000-8000-000000000099',
        remainingSeconds: 45,
        color: 0x123456,
      },
    ],
  },
  refresh: vi.fn(),
  activate: vi.fn(),
  remove: vi.fn(),
  clearAll: vi.fn(),
  destroy: vi.fn(),
  publishSnapshot: undefined as ((snapshot: TestRosterSnapshot) => void) | undefined,
}));

const transport = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  requestAndConnect: vi.fn(),
  disconnect: vi.fn(),
  onDisconnect: vi.fn((_listener: (info?: { description?: string }) => void) => () => {}),
  devicePicker: null as DevicePickerFn | null,
}));

const presence = vi.hoisted(() => ({
  reportLayers: vi.fn(),
  resolveAndBindBoard: vi.fn(),
  reportLayersForBoard: vi.fn(),
  reportDisconnectForBoard: vi.fn(),
  resetPresence: vi.fn(),
}));

const localRecovery = vi.hoisted(() => ({
  getDatabaseHandle: vi.fn(),
  getRoutePresenceClimbs: vi.fn(),
  getQuantumGeometry: vi.fn(),
  getQuantumGeometryGeneration: vi.fn(),
  getQueueSnapshot: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceActions: () => ({ reportLayers: presence.reportLayers }),
}));

vi.mock('../../components/ble/DevicePickerSheet', () => ({ DevicePickerSheet: () => 'quantum-device-picker' }));
vi.mock('../../lib/ble/bluetooth-status-store', () => ({
  registerBluetoothConnection: vi.fn(() => () => {}),
}));
vi.mock('../../lib/ble/use-ble-permissions', () => ({
  requestBleRuntimePermissions: vi.fn(async () => true),
}));
vi.mock('../../lib/ble/quantum-adapter', () => ({
  createQuantumBluetoothTransport: (devicePicker: DevicePickerFn) => {
    transport.devicePicker = devicePicker;
    return transport;
  },
}));
vi.mock('../../lib/ble/quantum-layer-identity-store', () => ({
  getOrCreateQuantumLayerIdentities: vi.fn(async () => [
    {
      slot: 0,
      controllerUserUuid: '20000000-0000-4000-8000-000000000001',
      color: { key: 'green', red: 0, green: 255, blue: 0, hex: '#00FF00' },
    },
    {
      slot: 1,
      controllerUserUuid: '20000000-0000-4000-8000-000000000002',
      color: { key: 'cyan', red: 0, green: 255, blue: 255, hex: '#00FFFF' },
    },
    {
      slot: 2,
      controllerUserUuid: '20000000-0000-4000-8000-000000000003',
      color: { key: 'magenta', red: 255, green: 0, blue: 255, hex: '#FF00FF' },
    },
    {
      slot: 3,
      controllerUserUuid: '20000000-0000-4000-8000-000000000004',
      color: { key: 'yellow', red: 255, green: 255, blue: 0, hex: '#FFFF00' },
    },
  ]),
}));
vi.mock('../../db', () => ({
  getDatabaseHandle: localRecovery.getDatabaseHandle,
}));
vi.mock('../../db/queries/quantum-route-presence-local', () => ({
  getQuantumRoutePresenceClimbsLocal: localRecovery.getRoutePresenceClimbs,
}));
vi.mock('../../lib/quantum-geometry-store', () => ({
  getQuantumGeometry: localRecovery.getQuantumGeometry,
  getQuantumGeometryGeneration: localRecovery.getQuantumGeometryGeneration,
}));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../lib/ble/quantum-transport', () => ({
  QuantumBoardController: class QuantumBoardController {
    private latestSnapshot: TestRosterSnapshot | undefined;

    constructor() {
      controller.publishSnapshot = (snapshot) => {
        this.latestSnapshot = snapshot;
      };
    }

    get snapshot(): TestRosterSnapshot | undefined {
      return this.latestSnapshot;
    }

    subscribe(): () => void {
      return () => {};
    }

    async refresh(): Promise<TestRosterSnapshot> {
      const snapshot = (await controller.refresh()) as TestRosterSnapshot;
      this.latestSnapshot = snapshot;
      return snapshot;
    }

    async activate(input: unknown): Promise<TestRosterSnapshot> {
      const snapshot = (await controller.activate(input)) as TestRosterSnapshot;
      this.latestSnapshot = snapshot;
      return snapshot;
    }

    async remove(input: unknown): Promise<TestRosterSnapshot> {
      const snapshot = (await controller.remove(input)) as TestRosterSnapshot;
      this.latestSnapshot = snapshot;
      return snapshot;
    }

    async clearAll(input: unknown): Promise<TestRosterSnapshot> {
      const snapshot = (await controller.clearAll(input)) as TestRosterSnapshot;
      this.latestSnapshot = snapshot;
      return snapshot;
    }

    destroy(): void {
      controller.destroy();
    }
  },
}));
vi.mock('../board-presence-provider', () => ({
  useBoardPresenceControls: () => ({
    enabled: true,
    boardId: null,
    resolveAndBindBoard: presence.resolveAndBindBoard,
    reportLayersForBoard: presence.reportLayersForBoard,
    reportDisconnectForBoard: presence.reportDisconnectForBoard,
    resetPresence: presence.resetPresence,
  }),
}));
vi.mock('../queue-provider', () => ({
  useQueueActions: () => ({ getQueueSnapshot: localRecovery.getQueueSnapshot }),
}));

import {
  QuantumBluetoothProvider,
  useQuantumBluetoothActions,
  useQuantumBluetoothState,
  type QuantumBluetoothActions,
  type QuantumBluetoothState,
} from '../quantum-bluetooth-provider';

let latestState: QuantumBluetoothState | null = null;
let latestActions: QuantumBluetoothActions | null = null;

function Probe() {
  const state = useQuantumBluetoothState();
  const actions = useQuantumBluetoothActions();
  useEffect(() => {
    latestState = state;
    latestActions = actions;
  }, [actions, state]);
  return null;
}

function provider(model: 'xl' | 'l') {
  return createElement(QuantumBluetoothProvider, {
    selectedModelId: model,
    children: createElement(Probe),
  });
}

function installPendingPickerAttempt(): AbortController {
  const abortController = new AbortController();
  transport.requestAndConnect.mockImplementationOnce(async () => {
    const devicePicker = transport.devicePicker;
    if (!devicePicker) throw new Error('Quantum device picker was not registered');
    await devicePicker((onUpdate) => onUpdate([]), abortController.signal);
    throw new Error('Pending picker unexpectedly selected a device');
  });
  transport.disconnect.mockImplementation(async () => {
    abortController.abort(new Error('Quantum connection attempt cancelled'));
  });
  return abortController;
}

describe('QuantumBluetoothProvider', () => {
  beforeEach(() => {
    latestState = null;
    latestActions = null;
    vi.clearAllMocks();
    transport.devicePicker = null;
    transport.isAvailable.mockResolvedValue(true);
    transport.requestAndConnect.mockResolvedValue({
      deviceId: 'device-1',
      deviceName: 'QB_AABBCCDDEEFF',
      serial: 'AABBCCDDEEFF',
      metadata: {
        model: { id: 'xl', displayName: 'XL', controllerType: 0, columns: 15, rows: 15 },
        controllerType: 0,
        columns: 15,
        rows: 15,
      },
    });
    transport.disconnect.mockResolvedValue(undefined);
    presence.resolveAndBindBoard.mockResolvedValue({ boardId: 73 });
    presence.reportLayersForBoard.mockResolvedValue({ boardId: 73, layers: [] });
    presence.reportDisconnectForBoard.mockResolvedValue(true);
    controller.refresh.mockResolvedValue(controller.initialSnapshot);
    controller.publishSnapshot = undefined;
    localRecovery.getDatabaseHandle.mockReturnValue(null);
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([]);
    localRecovery.getQuantumGeometryGeneration.mockReturnValue(1);
    localRecovery.getQuantumGeometry.mockImplementation((layoutId: number, sizeId: number) =>
      layoutId === 9101 && sizeId === 9201
        ? {
            layoutId,
            sizeId,
            revision: 'geometry-revision',
            edgeLeft: 0,
            edgeRight: 15_000,
            edgeBottom: 0,
            edgeTop: 15_000,
            placements: [
              { placementId: 1_000_001, holeId: 1_000_001, x: 1_000, y: 1_000, ledPosition: 1 },
              { placementId: 1_000_002, holeId: 1_000_002, x: 2_000, y: 2_000, ledPosition: 2 },
            ],
          }
        : null,
    );
    localRecovery.getQueueSnapshot.mockReturnValue({ queue: [], currentClimbQueueItem: null });
  });

  afterEach(cleanup);

  it('reports the initial confirmed roster directly to the resolved board', async () => {
    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());

    await act(async () => {
      await latestActions?.connect();
    });

    expect(latestState?.status).toBe('connected');
    expect(presence.resolveAndBindBoard).toHaveBeenCalledWith({
      serial: 'AABBCCDDEEFF',
      boardType: 'quantum',
      layoutId: 9101,
      sizeId: 9201,
      setIds: '1',
    });
    expect(presence.reportLayersForBoard).toHaveBeenCalledWith(73, [
      {
        color: '#123456',
        remainingSeconds: 45,
        climbUuid: null,
        angle: null,
        geometryKnown: false,
      },
    ]);
    expect(presence.reportLayers).not.toHaveBeenCalled();
    expect(JSON.stringify(presence.reportLayersForBoard.mock.calls)).not.toMatch(/routeId|userId|controller/i);
  });

  it('settles the picker and clears its sheet when the transport scan terminates', async () => {
    const abortController = installPendingPickerAttempt();
    const view = render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    let connectResult!: Promise<boolean>;
    act(() => {
      connectResult = latestActions!.connect();
    });
    await waitFor(() => expect(view.queryByText('quantum-device-picker')).not.toBeNull());

    let connected = true;
    await act(async () => {
      abortController.abort(new Error('BLE scan failed: radio failed'));
      connected = await connectResult;
    });

    expect(connected).toBe(false);
    expect(view.queryByText('quantum-device-picker')).toBeNull();
  });

  it('settles the picker and clears its sheet on an explicit disconnect', async () => {
    installPendingPickerAttempt();
    const view = render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    let connectResult!: Promise<boolean>;
    act(() => {
      connectResult = latestActions!.connect();
    });
    await waitFor(() => expect(view.queryByText('quantum-device-picker')).not.toBeNull());

    let connected = true;
    await act(async () => {
      await latestActions!.disconnect();
      connected = await connectResult;
    });

    expect(connected).toBe(false);
    expect(view.queryByText('quantum-device-picker')).toBeNull();
  });

  it('settles the picker and clears its sheet when the selected model changes', async () => {
    installPendingPickerAttempt();
    const view = render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    let connectResult!: Promise<boolean>;
    act(() => {
      connectResult = latestActions!.connect();
    });
    await waitFor(() => expect(view.queryByText('quantum-device-picker')).not.toBeNull());

    view.rerender(provider('l'));
    let connected = true;
    await act(async () => {
      connected = await connectResult;
    });

    expect(connected).toBe(false);
    expect(view.queryByText('quantum-device-picker')).toBeNull();
  });

  it('moves to disconnected and disposes the old controller on a model switch', async () => {
    const view = render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });

    view.rerender(provider('l'));

    await waitFor(() => expect(latestState?.status).toBe('disconnected'));
    expect(controller.destroy).toHaveBeenCalled();
    expect(transport.disconnect).toHaveBeenCalled();
    expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(73);
    expect(latestState?.connection).toBeNull();
  });

  it('disconnects a chooser result that resolves after its connection owner was detached', async () => {
    let resolveTransportConnection!: (connection: TestTransportConnection) => void;
    const deferredConnection = new Promise<TestTransportConnection>((resolve) => {
      resolveTransportConnection = resolve;
    });
    transport.requestAndConnect.mockReturnValueOnce(deferredConnection);

    const view = render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    let connectResult!: Promise<boolean>;
    act(() => {
      connectResult = latestActions!.connect();
    });
    await waitFor(() => expect(transport.requestAndConnect).toHaveBeenCalledOnce());

    view.rerender(provider('l'));
    await waitFor(() => expect(transport.disconnect).toHaveBeenCalledOnce());
    resolveTransportConnection({
      deviceId: 'stale-device',
      deviceName: 'QB_AABBCCDDEEFF',
      serial: 'AABBCCDDEEFF',
      metadata: {
        model: { id: 'xl', displayName: 'XL', controllerType: 0, columns: 15, rows: 15 },
        controllerType: 0,
        columns: 15,
        rows: 15,
      },
    });

    await expect(connectResult).resolves.toBe(false);
    expect(transport.disconnect).toHaveBeenCalledTimes(2);
    expect(latestState?.connection).toBeNull();
  });

  it('does not let deferred old-model teardown or its stale callback clear a replacement connection', async () => {
    let resolveOldDisconnect!: () => void;
    const oldDisconnect = new Promise<void>((resolve) => {
      resolveOldDisconnect = resolve;
    });
    transport.disconnect.mockImplementationOnce(() => oldDisconnect).mockResolvedValue(undefined);
    transport.requestAndConnect
      .mockResolvedValueOnce({
        deviceId: 'device-xl',
        deviceName: 'QB_AABBCCDDEEFF',
        serial: 'AABBCCDDEEFF',
        metadata: {
          model: { id: 'xl', displayName: 'XL', controllerType: 0, columns: 15, rows: 15 },
          controllerType: 0,
          columns: 15,
          rows: 15,
        },
      })
      .mockResolvedValueOnce({
        deviceId: 'device-l',
        deviceName: 'QB_FFEEDDCCBBAA',
        serial: 'FFEEDDCCBBAA',
        metadata: {
          model: { id: 'l', displayName: 'L', controllerType: 0, columns: 12, rows: 12 },
          controllerType: 0,
          columns: 12,
          rows: 12,
        },
      });

    const view = render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });
    const staleDisconnectCallback = transport.onDisconnect.mock.calls[0]?.[0];
    expect(staleDisconnectCallback).toBeDefined();

    view.rerender(provider('l'));
    await waitFor(() => expect(transport.disconnect).toHaveBeenCalledOnce());

    // The replacement can connect while the old native disconnect remains
    // pending because the old owner was detached synchronously.
    await act(async () => {
      await latestActions?.connect();
    });
    expect(latestState?.status).toBe('connected');
    expect(latestState?.connection?.serial).toBe('FFEEDDCCBBAA');

    const resetCountBeforeOldCompletion = presence.resetPresence.mock.calls.length;
    const disconnectReportCountBeforeOldCompletion = presence.reportDisconnectForBoard.mock.calls.length;
    const destroyCountBeforeStaleCallback = controller.destroy.mock.calls.length;

    await act(async () => {
      resolveOldDisconnect();
      await oldDisconnect;
    });
    staleDisconnectCallback?.({ description: 'Old controller disconnected late' });

    expect(latestState?.status).toBe('connected');
    expect(latestState?.connection?.serial).toBe('FFEEDDCCBBAA');
    expect(presence.resetPresence).toHaveBeenCalledTimes(resetCountBeforeOldCompletion);
    expect(presence.reportDisconnectForBoard).toHaveBeenCalledTimes(disconnectReportCountBeforeOldCompletion);
    expect(controller.destroy).toHaveBeenCalledTimes(destroyCountBeforeStaleCallback);
  });

  it('orders disconnect after an in-flight report and drops stale queued rosters', async () => {
    const events: string[] = [];
    let resolveFirstReport!: () => void;
    const firstReportFinished = new Promise<void>((resolve) => {
      resolveFirstReport = resolve;
    });
    presence.reportLayersForBoard.mockImplementation(async () => {
      events.push('report:start');
      await firstReportFinished;
      events.push('report:end');
      return { boardId: 73, layers: [] };
    });
    presence.reportDisconnectForBoard.mockImplementation(async () => {
      events.push('disconnect');
      return true;
    });

    const view = render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });
    await waitFor(() => expect(presence.reportLayersForBoard).toHaveBeenCalledOnce());

    // Queue a second roster behind the blocked initial report. It belongs to
    // the old connection and must never execute after the model switch.
    await act(async () => {
      await latestActions?.refresh();
    });
    view.rerender(provider('l'));
    await waitFor(() => expect(latestState?.status).toBe('disconnected'));
    expect(presence.reportDisconnectForBoard).not.toHaveBeenCalled();

    resolveFirstReport();
    await waitFor(() => expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(73));
    expect(presence.reportLayersForBoard).toHaveBeenCalledOnce();
    expect(events).toEqual(['report:start', 'report:end', 'disconnect']);
  });

  it('maps a confirmed local activation to display-safe presence only', async () => {
    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });
    controller.refresh.mockResolvedValue({ revision: 2, observedAtMs: 2_000, players: [] });
    presence.reportLayersForBoard.mockClear();
    controller.activate.mockResolvedValue({
      revision: 3,
      observedAtMs: 3_000,
      players: [
        {
          routeId: ROUTE_UUID,
          userId: CONTROLLER_USER_UUID,
          remainingSeconds: 120,
          color: 0x00ff00,
        },
      ],
    });

    await act(async () => {
      await latestActions?.activateLayer({
        slot: 0,
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [1, 2, 3],
        placementIds: [1_000_001, 1_000_002],
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        climbUuid: 'boardsesh-climb',
        angle: 40,
        geometryKnown: true,
      });
    });

    expect(controller.activate).toHaveBeenCalledWith({
      routeId: ROUTE_UUID,
      userId: CONTROLLER_USER_UUID,
      diodeIds: [1, 2, 3],
      color: 0x00ff00,
      durationSeconds: undefined,
      animation: undefined,
      expectedPlayers: [],
    });
    expect(presence.reportLayersForBoard).toHaveBeenCalledWith(73, [
      {
        color: '#00ff00',
        remainingSeconds: 120,
        climbUuid: 'boardsesh-climb',
        angle: 40,
        geometryKnown: true,
      },
    ]);
    expect(JSON.stringify(presence.reportLayersForBoard.mock.calls)).not.toMatch(/routeId|userId|controller/i);
  });

  it('recomputes a queued target when authoritative geometry changes during preflight', async () => {
    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });

    let finishPreflight!: (snapshot: TestRosterSnapshot) => void;
    const preflight = new Promise<TestRosterSnapshot>((resolve) => {
      finishPreflight = resolve;
    });
    controller.refresh.mockReturnValueOnce(preflight);
    controller.activate.mockResolvedValue({ revision: 3, observedAtMs: 3_000, players: [] });
    let activation!: ReturnType<QuantumBluetoothActions['activateLayer']>;
    act(() => {
      activation = latestActions!.activateLayer({
        slot: 0,
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [1],
        placementIds: [1_000_001],
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        climbUuid: 'candidate-climb',
        angle: 40,
        geometryKnown: true,
      });
    });
    await waitFor(() => expect(controller.refresh).toHaveBeenCalledTimes(2));

    localRecovery.getQuantumGeometryGeneration.mockReturnValue(2);
    localRecovery.getQuantumGeometry.mockReturnValue({
      layoutId: 9101,
      sizeId: 9201,
      revision: 'same-upstream-revision',
      edgeLeft: 0,
      edgeRight: 15_000,
      edgeBottom: 0,
      edgeTop: 15_000,
      placements: [{ placementId: 1_000_001, holeId: 1_000_001, x: 1_000, y: 1_000, ledPosition: 9 }],
    });
    await act(async () => {
      finishPreflight({ revision: 2, observedAtMs: 2_000, players: [] });
      await activation;
    });

    expect(controller.activate).toHaveBeenCalledWith(expect.objectContaining({ diodeIds: [9] }));
  });

  it('re-resolves a recovered foreign route after geometry replacement before overlap safety', async () => {
    const activeSnapshot: TestRosterSnapshot = {
      revision: 2,
      observedAtMs: 2_000,
      players: [
        {
          routeId: ACTIVE_ROUTE_UUID,
          userId: '20000000-0000-4000-8000-000000000099',
          remainingSeconds: 60,
          color: 0x123456,
        },
      ],
    };
    localRecovery.getQueueSnapshot.mockReturnValue({
      queue: [
        {
          uuid: 'active-climb',
          climb: {
            uuid: 'active-climb',
            boardType: 'quantum',
            layoutId: 9101,
            controllerRouteUuid: ACTIVE_ROUTE_UUID,
            angle: 30,
            frames: 'p1000001r12',
          },
        },
      ],
      currentClimbQueueItem: null,
    });
    controller.refresh.mockResolvedValue(activeSnapshot);

    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });

    localRecovery.getQuantumGeometryGeneration.mockReturnValue(2);
    localRecovery.getQuantumGeometry.mockReturnValue({
      layoutId: 9101,
      sizeId: 9201,
      revision: 'same-upstream-revision',
      edgeLeft: 0,
      edgeRight: 15_000,
      edgeBottom: 0,
      edgeTop: 15_000,
      placements: [
        { placementId: 1_000_001, holeId: 1_000_001, x: 1_000, y: 1_000, ledPosition: 2 },
        { placementId: 1_000_002, holeId: 1_000_002, x: 2_000, y: 2_000, ledPosition: 2 },
      ],
    });

    await expect(
      latestActions?.activateLayer({
        slot: 0,
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [2],
        placementIds: [1_000_002],
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        climbUuid: 'candidate-climb',
        angle: 40,
        geometryKnown: true,
      }),
    ).rejects.toThrow('overlaps an active layer');
    expect(controller.activate).not.toHaveBeenCalled();
  });

  it('blocks activation when refreshed local geometry overlaps another active route', async () => {
    controller.refresh.mockResolvedValueOnce({ revision: 1, observedAtMs: 1_000, players: [] });
    localRecovery.getQueueSnapshot.mockReturnValue({
      queue: [
        {
          uuid: 'active-climb',
          climb: {
            uuid: 'active-climb',
            boardType: 'quantum',
            layoutId: 9101,
            controllerRouteUuid: ACTIVE_ROUTE_UUID,
            angle: 30,
            frames: 'p1000001r12',
          },
        },
      ],
      currentClimbQueueItem: null,
    });

    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });
    controller.refresh.mockResolvedValue({
      revision: 2,
      observedAtMs: 2_000,
      players: [
        {
          routeId: ACTIVE_ROUTE_UUID,
          userId: '20000000-0000-4000-8000-000000000099',
          remainingSeconds: 60,
          color: 0x123456,
        },
      ],
    });

    await expect(
      latestActions?.activateLayer({
        slot: 0,
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [1],
        placementIds: [1_000_001],
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        climbUuid: 'candidate-climb',
        angle: 40,
        geometryKnown: true,
      }),
    ).rejects.toThrow('overlaps an active layer');
    expect(controller.activate).not.toHaveBeenCalled();
  });

  it('recovers a restored current climb before the first report and after reconnect', async () => {
    const staleQueueClimb = {
      uuid: 'stale-queue-climb',
      boardType: 'quantum',
      layoutId: 9101,
      controllerRouteUuid: ROUTE_UUID,
      angle: 20,
      frames: 'p1000001r12',
    };
    const restoredCurrentClimb = {
      ...staleQueueClimb,
      uuid: 'restored-current-climb',
      angle: 40,
      frames: 'p1000001r12p1000002r13',
    };
    localRecovery.getQueueSnapshot.mockReturnValue({
      queue: [{ uuid: staleQueueClimb.uuid, climb: staleQueueClimb }],
      currentClimbQueueItem: { uuid: restoredCurrentClimb.uuid, climb: restoredCurrentClimb },
    });
    controller.refresh.mockResolvedValue({
      revision: 3,
      observedAtMs: 3_000,
      players: [
        {
          routeId: ROUTE_UUID,
          userId: CONTROLLER_USER_UUID,
          remainingSeconds: 90,
          color: 0x00ff00,
        },
      ],
    });

    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });
    await waitFor(() =>
      expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
        {
          color: '#00ff00',
          remainingSeconds: 90,
          climbUuid: 'restored-current-climb',
          angle: 40,
          geometryKnown: true,
        },
      ]),
    );
    expect(localRecovery.getRoutePresenceClimbs).not.toHaveBeenCalled();

    await act(async () => {
      await latestActions?.disconnect();
    });
    presence.reportLayersForBoard.mockClear();
    await act(async () => {
      await latestActions?.connect();
    });

    await waitFor(() => expect(presence.reportLayersForBoard).toHaveBeenCalledOnce());
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      {
        color: '#00ff00',
        remainingSeconds: 90,
        climbUuid: 'restored-current-climb',
        angle: 40,
        geometryKnown: true,
      },
    ]);
    expect(JSON.stringify(presence.reportLayersForBoard.mock.calls)).not.toMatch(/routeId|userId|controller/i);
  });

  it('promotes an incomplete queue mapping with complete SQLite geometry', async () => {
    localRecovery.getQueueSnapshot.mockReturnValue({
      queue: [
        {
          uuid: 'partial-queue-climb',
          climb: {
            uuid: 'partial-queue-climb',
            boardType: 'quantum',
            layoutId: 9101,
            controllerRouteUuid: ROUTE_UUID,
            angle: 20,
            frames: 'p9999999r12',
          },
        },
      ],
      currentClimbQueueItem: null,
    });
    localRecovery.getDatabaseHandle.mockReturnValue({});
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([
      {
        uuid: 'complete-local-climb',
        controllerRouteUuid: ROUTE_UUID,
        angle: 40,
        frames: 'p1000001r12p1000002r13',
      },
    ]);
    controller.refresh.mockResolvedValue({
      revision: 3,
      observedAtMs: 3_000,
      players: [
        {
          routeId: ROUTE_UUID,
          userId: CONTROLLER_USER_UUID,
          remainingSeconds: 90,
          color: 0x00ff00,
        },
      ],
    });

    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });

    expect(localRecovery.getRoutePresenceClimbs).toHaveBeenCalledWith({}, 9101, [ROUTE_UUID.toLowerCase()]);
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      {
        color: '#00ff00',
        remainingSeconds: 90,
        climbUuid: 'complete-local-climb',
        angle: 40,
        geometryKnown: true,
      },
    ]);
  });

  it('keeps a queue recovery when the SQLite fallback is unavailable', async () => {
    const unknownRouteUuid = '10000000-0000-4000-8000-000000000099';
    const restoredCurrentClimb = {
      uuid: 'restored-current-climb',
      boardType: 'quantum',
      layoutId: 9101,
      controllerRouteUuid: ROUTE_UUID,
      angle: 40,
      frames: 'p1000001r12p1000002r13',
    };
    localRecovery.getQueueSnapshot.mockReturnValue({
      queue: [],
      currentClimbQueueItem: { uuid: restoredCurrentClimb.uuid, climb: restoredCurrentClimb },
    });
    localRecovery.getDatabaseHandle.mockReturnValue({});
    localRecovery.getRoutePresenceClimbs.mockRejectedValue(new Error('SQLite is locked'));
    controller.refresh.mockResolvedValue({
      revision: 4,
      observedAtMs: 4_000,
      players: [
        {
          routeId: ROUTE_UUID,
          userId: CONTROLLER_USER_UUID,
          remainingSeconds: 90,
          color: 0x00ff00,
        },
        {
          routeId: unknownRouteUuid,
          userId: '20000000-0000-4000-8000-000000000099',
          remainingSeconds: 45,
          color: 0x123456,
        },
      ],
    });

    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });

    await waitFor(() =>
      expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
        {
          color: '#00ff00',
          remainingSeconds: 90,
          climbUuid: 'restored-current-climb',
          angle: 40,
          geometryKnown: true,
        },
        {
          color: '#123456',
          remainingSeconds: 45,
          climbUuid: null,
          angle: null,
          geometryKnown: false,
        },
      ]),
    );
    expect(JSON.stringify(presence.reportLayersForBoard.mock.calls)).not.toMatch(/routeId|userId|controller/i);
  });

  it('never reports an older roster after deferred local recovery loses a revision race', async () => {
    const staleRouteUuid = '10000000-0000-4000-8000-000000000099';
    controller.refresh.mockResolvedValueOnce({ revision: 1, observedAtMs: 1_000, players: [] }).mockResolvedValueOnce({
      revision: 2,
      observedAtMs: 2_000,
      players: [
        {
          routeId: staleRouteUuid,
          userId: '20000000-0000-4000-8000-000000000099',
          remainingSeconds: 45,
          color: 0x123456,
        },
      ],
    });

    render(provider('xl'));
    await waitFor(() => expect(latestActions).not.toBeNull());
    await act(async () => {
      await latestActions?.connect();
    });
    presence.reportLayersForBoard.mockClear();

    let finishLocalLookup!: (climbs: []) => void;
    const deferredLocalLookup = new Promise<[]>((resolve) => {
      finishLocalLookup = resolve;
    });
    localRecovery.getDatabaseHandle.mockReturnValue({});
    localRecovery.getRoutePresenceClimbs.mockReturnValueOnce(deferredLocalLookup);

    let staleRefresh!: ReturnType<QuantumBluetoothActions['refresh']>;
    act(() => {
      staleRefresh = latestActions!.refresh();
    });
    await waitFor(() => expect(localRecovery.getRoutePresenceClimbs).toHaveBeenCalledOnce());

    const newerClimb = {
      uuid: 'newer-climb',
      boardType: 'quantum',
      layoutId: 9101,
      controllerRouteUuid: ROUTE_UUID,
      angle: 40,
      frames: 'p1000001r12p1000002r13',
    };
    localRecovery.getQueueSnapshot.mockReturnValue({
      queue: [],
      currentClimbQueueItem: { uuid: newerClimb.uuid, climb: newerClimb },
    });
    controller.publishSnapshot?.({
      revision: 3,
      observedAtMs: 3_000,
      players: [
        {
          routeId: ROUTE_UUID,
          userId: CONTROLLER_USER_UUID,
          remainingSeconds: 120,
          color: 0x00ff00,
        },
      ],
    });
    expect(presence.reportLayersForBoard).not.toHaveBeenCalled();

    await act(async () => {
      finishLocalLookup([]);
      await staleRefresh;
    });
    expect(presence.reportLayersForBoard).toHaveBeenCalledOnce();
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      {
        color: '#00ff00',
        remainingSeconds: 120,
        climbUuid: 'newer-climb',
        angle: 40,
        geometryKnown: true,
      },
    ]);

    controller.refresh.mockResolvedValueOnce({
      revision: 4,
      observedAtMs: 4_000,
      players: [
        {
          routeId: ROUTE_UUID,
          userId: CONTROLLER_USER_UUID,
          remainingSeconds: 110,
          color: 0x00ff00,
        },
      ],
    });
    await act(async () => {
      await latestActions?.refresh();
    });

    expect(presence.reportLayersForBoard).toHaveBeenCalledTimes(2);
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      {
        color: '#00ff00',
        remainingSeconds: 110,
        climbUuid: 'newer-climb',
        angle: 40,
        geometryKnown: true,
      },
    ]);
  });
});
