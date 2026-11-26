// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';
import { getQuantumBundledGeometry } from '@boardsesh/board-constants/quantum';
import type { QuantumActivateTransaction } from '@boardsesh/ble-protocol/quantum';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useQuantumBluetoothSelection } from '../use-quantum-bluetooth-selection';
import { QueueRestoredContext, QueueSessionIdContext } from '../queue/queue-contexts';
import type { DevicePickerFn } from '../../lib/ble/types';
import { invalidateCredentialSnapshots } from '../../lib/privacy/privacy-cache';

const ROUTE_UUID = '10000000-0000-4000-8000-000000000001';
const ACTIVE_ROUTE_UUID = '10000000-0000-4000-8000-000000000002';
const CONTROLLER_USER_UUID = '20000000-0000-4000-8000-000000000001';
const STARTED_SESSION_USER_UUID = '20000000-0000-4000-8000-000000000004';
const ACTIVATION = {
  slot: 0,
  controllerRouteUuid: ROUTE_UUID,
  diodeIds: [1],
  placementIds: [1_000_001],
  layoutId: 9101,
  sizeId: 9201,
  geometryGeneration: 1,
  geometryKnown: true as const,
};

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

const permissions = vi.hoisted(() => ({ request: vi.fn() }));

const presence = vi.hoisted(() => ({
  reportLayers: vi.fn(),
  resolveAndBindBoard: vi.fn(),
  reportLayersForBoard: vi.fn(),
  reportDisconnectForBoard: vi.fn(),
  resetPresence: vi.fn(),
}));

const localRecovery = vi.hoisted(() => ({
  isQuantumClimbRetired: vi.fn(),
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
  requestBleRuntimePermissions: permissions.request,
}));
vi.mock('../../lib/ble/quantum-adapter', () => ({
  createQuantumBluetoothTransport: (devicePicker: DevicePickerFn) => {
    transport.devicePicker = devicePicker;
    return transport;
  },
}));
const playerStorage = vi.hoisted(() => ({
  solo: vi.fn(),
  session: vi.fn(),
  creatorMarker: vi.fn(),
}));
vi.mock('../../lib/ble/quantum-layer-identity-store', () => ({
  getOrCreateQuantumSoloPlayer: playerStorage.solo,
  getQuantumSessionPlayer: playerStorage.session,
}));
vi.mock('../../lib/session-store', () => ({ getStoredCreatedSessionId: playerStorage.creatorMarker }));
vi.mock('../../db', () => ({
  getDatabaseHandle: localRecovery.getDatabaseHandle,
}));
vi.mock('../feature-flags-provider', () => ({
  useFeatureFlag: () => true,
  useFeatureFlagsResolved: () => true,
}));
vi.mock('../../db/queries/quantum-climb-retirement', () => ({
  isQuantumClimbRetired: localRecovery.isQuantumClimbRetired,
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

    async refresh(isEligible?: () => boolean): Promise<TestRosterSnapshot> {
      const snapshot = (await controller.refresh(isEligible)) as TestRosterSnapshot;
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

function provider(
  model: 'xl' | 'l' | 'm' | 'belay' | null,
  selectedBoardUuid?: string,
  preferredSerial?: string,
  scope: { sessionId?: string; accountId?: string; getCurrentSessionId?: () => string | null } = {},
) {
  return createElement(QuantumBluetoothProvider, {
    selectedModelId: model,
    selectedBoardUuid,
    preferredSerial,
    ...scope,
    children: createElement(Probe),
  });
}

function WithWrappedSelection({ isBoardSelectionCurrent }: { isBoardSelectionCurrent: () => boolean }) {
  const board = { uuid: 'board-A', boardType: 'quantum', layoutId: 9101, sizeId: 9201 } as UserBoard;
  const selection = useQuantumBluetoothSelection(board, isBoardSelectionCurrent);
  return createElement(QuantumBluetoothProvider, { ...selection, children: createElement(Probe) });
}

function installPendingPickerAttempt(): AbortController {
  const abortController = new AbortController();
  transport.requestAndConnect.mockImplementationOnce(async () => {
    const devicePicker = transport.devicePicker;
    if (!devicePicker) throw new Error('Quantum device picker was not registered');
    await devicePicker((onUpdate) => onUpdate([]), undefined, abortController.signal);
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
    permissions.request.mockReset().mockResolvedValue(true);
    playerStorage.solo.mockReset().mockResolvedValue({
      controllerUserUuid: CONTROLLER_USER_UUID,
    });
    playerStorage.session.mockReset().mockResolvedValue(null);
    playerStorage.creatorMarker.mockReset().mockResolvedValue(null);
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
    presence.resetPresence.mockReset();
    presence.resolveAndBindBoard.mockResolvedValue({ boardId: 73 });
    presence.reportLayersForBoard.mockResolvedValue({ boardId: 73, layers: [] });
    presence.reportDisconnectForBoard.mockResolvedValue(true);
    controller.refresh.mockResolvedValue(controller.initialSnapshot);
    controller.publishSnapshot = undefined;
    localRecovery.getDatabaseHandle.mockReturnValue(null);
    localRecovery.isQuantumClimbRetired.mockReset().mockResolvedValue(false);
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

  it('waits for saved-session authority even when the solo queue is already available', async () => {
    const isBoardSelectionCurrent = () => true;
    const wrap = (sessionAuthorityReady: boolean) =>
      createElement(QueueSessionIdContext.Provider, {
        value: { sessionId: null, undoScope: 'offline', sessionAuthorityReady, accountId: 'returning-account' },
        children: createElement(QueueRestoredContext.Provider, {
          value: true,
          children: createElement(WithWrappedSelection, { isBoardSelectionCurrent }),
        }),
      });
    const view = render(wrap(false));

    expect(latestState?.driverStatus).toBe('checking');
    await expect(latestActions!.connect()).resolves.toBe(false);
    await expect(latestActions!.activateLayer(ACTIVATION)).rejects.toThrow('not connected');
    expect(playerStorage.solo).not.toHaveBeenCalled();
    expect(permissions.request).not.toHaveBeenCalled();
    expect(transport.requestAndConnect).not.toHaveBeenCalled();

    // A confirmed offline solo session is allowed to use its local player.
    view.rerender(wrap(true));
    await waitFor(() => expect(latestState?.driverStatus).toBe('available'));
    expect(playerStorage.solo).toHaveBeenCalled();
  });

  it.each(['joined', 'lost credential'] as const)(
    'checks device provenance for a %s phone on the same account',
    async (kind) => {
      playerStorage.creatorMarker.mockResolvedValue(kind === 'joined' ? null : 'shared-room');
      render(provider('xl', 'board-A', undefined, { sessionId: 'shared-room', accountId: 'same-account' }));
      await waitFor(() => expect(latestState?.driverStatus).toBe('peer'));
      await expect(latestActions!.connect()).resolves.toBe(false);
      await expect(latestActions!.activateLayer(ACTIVATION)).rejects.toThrow('not connected');
      await expect(
        latestActions!.removeLayer({
          controllerUserUuid: CONTROLLER_USER_UUID,
          controllerRouteUuid: ROUTE_UUID,
        }),
      ).rejects.toThrow('not connected');
      expect(playerStorage.solo).not.toHaveBeenCalled();
      expect(playerStorage.session).toHaveBeenCalledTimes(kind === 'joined' ? 0 : 1);
      expect(permissions.request).not.toHaveBeenCalled();
      expect(transport.requestAndConnect).not.toHaveBeenCalled();
    },
  );

  it('uses the originating phone session credential and permits only scoped cleanup', async () => {
    playerStorage.creatorMarker.mockResolvedValue('shared-room');
    playerStorage.session.mockResolvedValue({
      controllerUserUuid: STARTED_SESSION_USER_UUID,
    });
    controller.refresh.mockResolvedValue({ revision: 1, observedAtMs: 1_000, players: [] });
    controller.activate.mockResolvedValue({ revision: 2, observedAtMs: 1_100, players: [] });
    controller.remove.mockResolvedValue({ revision: 3, observedAtMs: 1_200, players: [] });
    render(provider('xl', 'board-A', undefined, { sessionId: 'shared-room', accountId: 'same-account' }));
    await waitFor(() => expect(latestState?.driverStatus).toBe('available'));
    await act(async () => {
      expect(await latestActions!.connect()).toBe(true);
      await Promise.resolve();
    });
    await act(async () => {
      await latestActions!.activateLayer(ACTIVATION);
      await expect(
        latestActions!.removeLayer({
          controllerUserUuid: CONTROLLER_USER_UUID,
          controllerRouteUuid: ROUTE_UUID,
        }),
      ).rejects.toThrow('does not own');
      expect(controller.remove).not.toHaveBeenCalled();
      await latestActions!.removeLayer({
        controllerUserUuid: STARTED_SESSION_USER_UUID,
        controllerRouteUuid: ROUTE_UUID,
      });
    });
    expect(controller.activate).toHaveBeenCalledWith(expect.objectContaining({ userId: STARTED_SESSION_USER_UUID }));
    expect(controller.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: STARTED_SESSION_USER_UUID,
        routeId: ROUTE_UUID,
      }),
    );
    expect(playerStorage.solo).not.toHaveBeenCalled();
  });

  it.each(['flag', 'model', 'account', 'session'] as const)(
    'drops an accepted activation during roster preflight when %s changes',
    async (scopeChange) => {
      const view = render(provider('xl'));
      await act(async () => {
        await latestActions!.connect();
      });
      let finishPreflight!: (snapshot: TestRosterSnapshot) => void;
      controller.refresh.mockReturnValueOnce(
        new Promise<TestRosterSnapshot>((resolve) => {
          finishPreflight = resolve;
        }),
      );
      const activation = latestActions!.activateLayer(ACTIVATION);
      const rejected = expect(activation).rejects.toThrow('connection changed during activation preflight');
      await waitFor(() => expect(controller.refresh).toHaveBeenCalledTimes(2));
      const writeGuard = controller.refresh.mock.calls[1][0] as () => boolean;
      expect(writeGuard()).toBe(true);

      if (scopeChange === 'account') {
        act(invalidateCredentialSnapshots);
      } else if (scopeChange === 'session') {
        view.rerender(provider('xl', undefined, undefined, { sessionId: 'shared-room', accountId: 'same-account' }));
      } else {
        view.rerender(provider(scopeChange === 'flag' ? null : 'm'));
      }
      expect(writeGuard()).toBe(false);
      await act(async () => {
        finishPreflight({ revision: 2, observedAtMs: 2_000, players: [] });
        await rejected;
      });
      expect(controller.activate).not.toHaveBeenCalled();
      expect(controller.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['board persistence', 'LEAVE'] as const)(
    'blocks freshly rendered actions on the old link during pending %s',
    async (pending) => {
      let boardReady = true;
      let leavePending = false;
      let sessionRevision = 0;
      playerStorage.creatorMarker.mockResolvedValue('room-A');
      playerStorage.session.mockResolvedValue({ controllerUserUuid: STARTED_SESSION_USER_UUID });
      const sessionContext = {
        sessionId: 'room-A',
        sessionAuthorityReady: true,
        accountId: 'account-A',
        undoScope: 'test',
        getCurrentSessionId: () => 'room-A',
        getSessionContextRevision: () => sessionRevision,
        isSessionLeavePending: () => leavePending,
      };
      const renderSelection = () =>
        createElement(
          QueueSessionIdContext.Provider,
          { value: sessionContext },
          createElement(
            QueueRestoredContext.Provider,
            { value: true },
            createElement(WithWrappedSelection, { isBoardSelectionCurrent: () => boardReady }),
          ),
        );
      const view = render(renderSelection());
      await waitFor(() => expect(latestState?.driverStatus).toBe('available'));
      await act(async () => {
        await latestActions!.connect();
      });
      const oldActions = latestActions;
      controller.refresh.mockClear();
      if (pending === 'board persistence') boardReady = false;
      else {
        leavePending = true;
        sessionRevision += 1;
      }
      view.rerender(renderSelection());
      expect(latestState?.status).toBe('connected');
      expect(latestActions).not.toBe(oldActions);
      await expect(latestActions!.activateLayer(ACTIVATION)).rejects.toThrow('not connected');
      await expect(
        latestActions!.removeLayer({
          controllerUserUuid: STARTED_SESSION_USER_UUID,
          controllerRouteUuid: ROUTE_UUID,
        }),
      ).rejects.toThrow('not connected');
      expect(controller.refresh).not.toHaveBeenCalled();
      expect(controller.activate).not.toHaveBeenCalled();
      expect(controller.remove).not.toHaveBeenCalled();
    },
  );

  it.each(['before preflight', 'after preflight'] as const)(
    'blocks a retired climb %s and permits removal of an already owned layer',
    async (phase) => {
      const late = phase === 'after preflight';
      controller.refresh.mockResolvedValue({ revision: 1, observedAtMs: 1_000, players: [] });
      controller.remove.mockResolvedValue({ revision: 2, observedAtMs: 2_000, players: [] });
      render(provider('xl'));
      await act(async () => {
        await latestActions!.connect();
      });
      controller.refresh.mockClear();
      localRecovery.isQuantumClimbRetired.mockResolvedValueOnce(!late).mockResolvedValue(true);
      const write = vi.fn();
      if (late) {
        controller.activate.mockImplementationOnce(async (request: QuantumActivateTransaction) => {
          await request.assertTargetAvailable?.();
          write();
          return { revision: 2, observedAtMs: 2_000, players: [] };
        });
      }
      await expect(
        latestActions!.activateLayer({
          ...ACTIVATION,
          climbUuid: 'retained-quantum-climb',
        }),
      ).rejects.toThrow('no longer available to light');
      expect(controller.refresh).toHaveBeenCalledTimes(late ? 1 : 0);
      expect(controller.activate).toHaveBeenCalledTimes(late ? 1 : 0);
      expect(write).not.toHaveBeenCalled();
      await act(async () => {
        await latestActions!.removeLayer({ controllerUserUuid: CONTROLLER_USER_UUID, controllerRouteUuid: ROUTE_UUID });
      });
      expect(controller.remove).toHaveBeenCalledOnce();
    },
  );

  it('requires a new explicit connection after re-enabling and retires the previous link callback', async () => {
    const view = render(provider('xl'));
    await act(async () => {
      await latestActions!.connect();
    });
    const oldActions = latestActions!;
    view.rerender(provider(null));
    view.rerender(provider('xl'));
    expect(latestState?.status).toBe('disconnected');
    expect(transport.requestAndConnect).toHaveBeenCalledOnce();
    await act(async () => {
      await latestActions!.connect();
    });
    expect(latestState?.status).toBe('connected');
    await expect(oldActions.activateLayer(ACTIVATION)).rejects.toThrow('not connected');
    await expect(
      oldActions.removeLayer({
        controllerUserUuid: CONTROLLER_USER_UUID,
        controllerRouteUuid: ROUTE_UUID,
      }),
    ).rejects.toThrow('not connected');
    expect(controller.activate).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
  });

  it('refuses a Belay configuration even if directly passed to the provider', async () => {
    render(provider('belay'));
    expect(latestState?.status).toBe('inactive');
    await expect(latestActions!.connect()).resolves.toBe(false);
    expect(transport.requestAndConnect).not.toHaveBeenCalled();
  });

  it.each(['existing', 'pending'] as const)(
    'leaves an %s legacy board presence binding alone while inactive',
    async (bindingPhase) => {
      let cancelled = false;
      let boundBoardId: number | null = bindingPhase === 'existing' ? 41 : null;
      let finishLegacyBinding!: (binding: { boardId: number }) => void;
      const pendingBinding = new Promise<{ boardId: number }>((resolve) => {
        finishLegacyBinding = resolve;
      });
      const legacyBinding = pendingBinding.then((binding) => {
        if (!cancelled) boundBoardId = binding.boardId;
      });
      presence.resetPresence.mockImplementation(() => {
        cancelled = true;
        boundBoardId = null;
      });

      const view = render(provider(null, undefined, 'KILTER-A'));
      view.rerender(provider(null, undefined, 'KILTER-B'));
      view.unmount();
      if (bindingPhase === 'pending') {
        finishLegacyBinding({ boardId: 42 });
        await legacyBinding;
      }
      expect(boundBoardId).toBe(bindingPhase === 'existing' ? 41 : 42);
      expect(presence.resetPresence).not.toHaveBeenCalled();
      expect(presence.reportDisconnectForBoard).not.toHaveBeenCalled();
      expect(transport.disconnect).not.toHaveBeenCalled();
      expect(permissions.request).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'AABBCCDDEEFF'])(
    'retires a physical board when another saved board has the same model (serial %s)',
    async (serial) => {
      const view = render(provider('xl', 'board-A', serial));
      await act(async () => {
        await latestActions!.connect();
      });
      expect(latestState?.status).toBe('connected');
      transport.disconnect.mockClear();
      presence.reportLayersForBoard.mockClear();

      view.rerender(provider('xl', 'board-B', serial ? 'FFEEDDCCBBAA' : undefined));
      await waitFor(() => expect(transport.disconnect).toHaveBeenCalledOnce());
      expect(latestState?.status).toBe('disconnected');
      expect(latestState?.connection).toBeNull();
      expect(latestState?.roster).toBeNull();
      expect(presence.reportDisconnectForBoard).toHaveBeenCalledWith(73);
      await expect(
        latestActions!.removeLayer({
          controllerUserUuid: CONTROLLER_USER_UUID,
          controllerRouteUuid: ROUTE_UUID,
        }),
      ).rejects.toThrow('not connected');
      expect(controller.remove).not.toHaveBeenCalled();
      expect(presence.reportLayersForBoard).not.toHaveBeenCalled();
    },
  );

  it('cancels a pending chooser when the saved board changes without changing model or serial', async () => {
    installPendingPickerAttempt();
    const view = render(provider('xl', 'board-A'));
    let connectResult!: Promise<boolean>;
    act(() => {
      connectResult = latestActions!.connect();
    });
    await waitFor(() => expect(view.queryByText('quantum-device-picker')).not.toBeNull());
    view.rerender(provider('xl', 'board-B'));
    await act(async () => {
      expect(await connectResult).toBe(false);
    });
    expect(view.queryByText('quantum-device-picker')).toBeNull();
    expect(presence.resolveAndBindBoard).not.toHaveBeenCalled();
  });

  it.each(['disconnect', 'selection', 'unmount'] as const)(
    'drops a late permission grant after %s, before starting transport or presence',
    async (cancellation) => {
      let grantPermission!: (granted: boolean) => void;
      permissions.request.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          grantPermission = resolve;
        }),
      );
      const view = render(provider('xl', 'board-A'));
      let connectResult!: Promise<boolean>;
      act(() => {
        connectResult = latestActions!.connect();
      });
      await waitFor(() => expect(permissions.request).toHaveBeenCalledOnce());
      if (cancellation === 'disconnect')
        await act(async () => {
          await latestActions!.disconnect();
        });
      else if (cancellation === 'selection') view.rerender(provider('xl', 'board-B'));
      else view.unmount();

      await act(async () => {
        grantPermission(true);
        expect(await connectResult).toBe(false);
      });
      expect(transport.requestAndConnect).not.toHaveBeenCalled();
      expect(presence.resolveAndBindBoard).not.toHaveBeenCalled();
      expect(presence.reportLayersForBoard).not.toHaveBeenCalled();
    },
  );

  it('does not let a cancelled preflight clear the replacement connect promise or report an error', async () => {
    let grantOldPermission!: (granted: boolean) => void;
    let grantNewPermission!: (granted: boolean) => void;
    permissions.request
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          grantOldPermission = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          grantNewPermission = resolve;
        }),
      );
    render(provider('xl', 'board-A'));
    let oldConnect!: Promise<boolean>;
    let newConnect!: Promise<boolean>;
    act(() => {
      oldConnect = latestActions!.connect();
    });
    await act(async () => {
      await latestActions!.disconnect();
    });
    act(() => {
      newConnect = latestActions!.connect();
    });
    await act(async () => {
      grantOldPermission(true);
      expect(await oldConnect).toBe(false);
    });
    expect(latestState?.status).toBe('connecting');
    expect(latestState?.lastError).toBeNull();
    expect(latestActions!.connect()).toBe(newConnect);
    await act(async () => {
      grantNewPermission(true);
      expect(await newConnect).toBe(true);
    });
    expect(transport.requestAndConnect).toHaveBeenCalledOnce();
  });

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
      isEligible: expect.any(Function),
      assertTargetAvailable: expect.any(Function),
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
    localRecovery.getDatabaseHandle.mockReturnValue({});
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([
      {
        uuid: 'active-climb',
        controllerRouteUuid: ACTIVE_ROUTE_UUID,
        angle: 30,
        frames: 'p1000001r12',
      },
    ]);
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
    localRecovery.getDatabaseHandle.mockReturnValue({});
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([
      {
        uuid: 'active-climb',
        controllerRouteUuid: ACTIVE_ROUTE_UUID,
        angle: 30,
        frames: 'p1000001r12',
      },
    ]);
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

  it('recovers a downloaded source row before the first report and after reconnect', async () => {
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
    localRecovery.getDatabaseHandle.mockReturnValue({});
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([restoredCurrentClimb]);
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
    expect(localRecovery.getRoutePresenceClimbs).toHaveBeenCalledOnce();

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

  it('uses verified SQLite geometry instead of an incomplete queue mapping', async () => {
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

    expect(localRecovery.getRoutePresenceClimbs).toHaveBeenCalledWith({}, 9101, 9201, [ROUTE_UUID.toLowerCase()]);
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

  it('keeps queue geometry unresolved when verified SQLite recovery is unavailable', async () => {
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
          climbUuid: null,
          angle: null,
          geometryKnown: false,
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

  it('drops recovered geometry when a later download no longer verifies source ownership', async () => {
    const activeSnapshot: TestRosterSnapshot = {
      revision: 2,
      observedAtMs: 2_000,
      players: [
        {
          routeId: ACTIVE_ROUTE_UUID,
          userId: '20000000-0000-4000-8000-000000000099',
          remainingSeconds: 90,
          color: 0x00ff00,
        },
      ],
    };
    localRecovery.getDatabaseHandle.mockReturnValue({});
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([
      { uuid: 'source-climb', controllerRouteUuid: ACTIVE_ROUTE_UUID, angle: 40, frames: 'p1000001r12' },
    ]);
    controller.refresh.mockResolvedValue(activeSnapshot);
    render(provider('xl'));
    await act(async () => {
      await latestActions!.connect();
    });
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      expect.objectContaining({ geometryKnown: true }),
    ]);

    // The query now excludes the row: it is authored, retained, or lacks provenance.
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([]);
    await act(async () => {
      await latestActions!.refresh();
    });
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      expect.objectContaining({ climbUuid: null, angle: null, geometryKnown: false }),
    ]);
    await expect(
      latestActions!.activateLayer({
        slot: 1,
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [2],
        placementIds: [1_000_002],
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        geometryKnown: true,
      }),
    ).rejects.toThrow('diode geometry is unavailable');
    expect(controller.activate).not.toHaveBeenCalled();
  });

  it('preserves physical holds after an authored edit while another client fails closed on its changed cache', async () => {
    localRecovery.getDatabaseHandle.mockReturnValue({});
    controller.refresh.mockResolvedValue({ revision: 1, observedAtMs: 1_000, players: [] });
    const firstClient = render(provider('xl'));
    await act(async () => {
      await latestActions!.connect();
    });
    const physicalSnapshot: TestRosterSnapshot = {
      revision: 2,
      observedAtMs: 2_000,
      players: [{ routeId: ROUTE_UUID, userId: CONTROLLER_USER_UUID, remainingSeconds: 90, color: 0x00ff00 }],
    };
    controller.activate.mockResolvedValue(physicalSnapshot);
    await act(async () => {
      await latestActions!.activateLayer({
        slot: 0,
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [1],
        placementIds: [1_000_001],
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        climbUuid: 'authored-climb',
        angle: 40,
        geometryKnown: true,
      });
    });
    controller.activate.mockClear();
    controller.refresh.mockResolvedValue(physicalSnapshot);
    // Another phone saves frame B under the same UUID, while this wall still lights A.
    const editedClimb = {
      uuid: 'authored-climb',
      boardType: 'quantum',
      layoutId: 9101,
      controllerRouteUuid: ROUTE_UUID,
      angle: 40,
      frames: 'p1000002r12',
    };
    localRecovery.getQueueSnapshot.mockReturnValue({
      queue: [{ uuid: editedClimb.uuid, climb: editedClimb }],
      currentClimbQueueItem: { uuid: editedClimb.uuid, climb: editedClimb },
    });
    // Authored frame B exists in SQLite, but the provenance-filtered query excludes it.
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([]);
    localRecovery.getRoutePresenceClimbs.mockClear();
    await act(async () => {
      await latestActions!.refresh();
    });
    expect(localRecovery.getRoutePresenceClimbs).not.toHaveBeenCalled();
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      expect.objectContaining({ climbUuid: 'authored-climb', geometryKnown: true }),
    ]);
    const overlapCandidate = {
      slot: 1,
      controllerRouteUuid: ACTIVE_ROUTE_UUID,
      diodeIds: [1],
      placementIds: [1_000_001],
      layoutId: 9101,
      sizeId: 9201,
      geometryGeneration: 1,
      geometryKnown: true as const,
    };
    // A separate installation has no physical confirmation. Queue B cannot prove A.
    firstClient.unmount();
    playerStorage.solo.mockResolvedValue({
      controllerUserUuid: '20000000-0000-4000-8000-000000000003',
    });
    presence.reportLayersForBoard.mockClear();
    render(provider('xl'));
    await act(async () => {
      await latestActions!.connect();
    });
    expect(localRecovery.getRoutePresenceClimbs).toHaveBeenCalledWith({}, 9101, 9201, [ROUTE_UUID]);
    expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
      expect.objectContaining({ climbUuid: null, angle: null, geometryKnown: false }),
    ]);
    await expect(latestActions!.activateLayer(overlapCandidate)).rejects.toThrow('diode geometry is unavailable');
    expect(controller.activate).not.toHaveBeenCalled();
  });

  it.each(['replaced owner', 'multiple owners'] as const)(
    'discards a local hold confirmation before preflight when the same mutable route has %s',
    async (ownership) => {
      localRecovery.getDatabaseHandle.mockReturnValue({});
      controller.refresh.mockResolvedValue({ revision: 1, observedAtMs: 1_000, players: [] });
      render(provider('xl'));
      await act(async () => {
        await latestActions!.connect();
      });
      const originalPlayer = {
        routeId: ROUTE_UUID,
        userId: CONTROLLER_USER_UUID,
        remainingSeconds: 90,
        color: 0x00ff00,
      };
      controller.activate.mockResolvedValue({ revision: 2, observedAtMs: 2_000, players: [originalPlayer] });
      await act(async () => {
        await latestActions!.activateLayer({
          slot: 0,
          controllerRouteUuid: ROUTE_UUID,
          diodeIds: [1],
          placementIds: [1_000_001],
          layoutId: 9101,
          sizeId: 9201,
          geometryGeneration: 1,
          climbUuid: 'authored-climb',
          angle: 40,
          geometryKnown: true,
        });
      });
      controller.activate.mockClear();
      // Another installation lights the edited route on diode 2 under its own user.
      // The old confirmation only described diode 1 for the original user.
      const updatedPlayers = [
        ...(ownership === 'multiple owners' ? [originalPlayer] : []),
        { ...originalPlayer, userId: '20000000-0000-4000-8000-000000000099', color: 0xff00ff },
      ];
      controller.refresh.mockResolvedValue({ revision: 3, observedAtMs: 3_000, players: updatedPlayers });
      await expect(
        latestActions!.activateLayer({
          slot: 1,
          controllerRouteUuid: ACTIVE_ROUTE_UUID,
          diodeIds: [2],
          placementIds: [1_000_002],
          layoutId: 9101,
          sizeId: 9201,
          geometryGeneration: 1,
          geometryKnown: true,
        }),
      ).rejects.toThrow('diode geometry is unavailable');
      expect(controller.activate).not.toHaveBeenCalled();
      expect(localRecovery.getRoutePresenceClimbs).toHaveBeenCalledWith({}, 9101, 9201, [ROUTE_UUID]);
      expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(
        73,
        updatedPlayers.map(() => expect.objectContaining({ climbUuid: null, angle: null, geometryKnown: false })),
      );
      expect(JSON.stringify(presence.reportLayersForBoard.mock.calls)).not.toMatch(/routeId|userId|controller/i);
    },
  );

  it.each([93, 128])('rejects a %i-diode layer before any controller command', async (diodeCount) => {
    controller.refresh.mockResolvedValue({ revision: 1, observedAtMs: 1_000, players: [] });
    render(provider('xl'));
    await act(async () => {
      await latestActions!.connect();
    });
    controller.refresh.mockClear();
    presence.reportLayersForBoard.mockClear();

    await expect(
      latestActions!.activateLayer({
        slot: 0,
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: Array.from({ length: diodeCount }, (_, diodeIndex) => diodeIndex + 1),
        placementIds: Array.from({ length: diodeCount }, (_, diodeIndex) => 1_000_001 + diodeIndex),
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        geometryKnown: true,
      }),
    ).rejects.toThrow('Quantum layers require 1 to 92 unique diodes');

    expect(controller.refresh).not.toHaveBeenCalled();
    expect(controller.activate).not.toHaveBeenCalled();
    expect(controller.remove).not.toHaveBeenCalled();
    expect(presence.reportLayersForBoard).not.toHaveBeenCalled();
  });

  it('changes the selected color using the same player and expected prior route', async () => {
    const physicalSnapshot: TestRosterSnapshot = {
      revision: 2,
      observedAtMs: 2_000,
      players: [{ routeId: ROUTE_UUID, userId: CONTROLLER_USER_UUID, remainingSeconds: 90, color: 0x00ff00 }],
    };
    controller.refresh.mockResolvedValue(physicalSnapshot);
    controller.activate.mockResolvedValue({
      ...physicalSnapshot,
      players: [{ ...physicalSnapshot.players[0], color: 0x00ffff }],
    });
    render(provider('xl'));
    await act(async () => {
      await latestActions!.connect();
    });
    await act(async () => {
      await latestActions!.activateLayer({
        slot: 1,
        controllerRouteUuid: ROUTE_UUID,
        expectedOwnedRouteUuid: ROUTE_UUID,
        diodeIds: [1],
        placementIds: [1_000_001],
        layoutId: 9101,
        sizeId: 9201,
        geometryGeneration: 1,
        geometryKnown: true,
      });
    });
    expect(controller.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CONTROLLER_USER_UUID,
        color: 0x00ffff,
        expectedOwnedRouteId: ROUTE_UUID,
      }),
    );
  });

  it('keeps a real XL-only downloaded route unknown on M and blocks lighting beside it', async () => {
    const database = createTestDatabase();
    await runMigrations(database);
    const medium = getQuantumBundledGeometry(9101, 9203)!;
    const mediumIds = new Set(medium.placements.map((placement) => placement.placementId));
    const xlOnly = getQuantumBundledGeometry(9101, 9201)!.placements.find(
      (placement) => !mediumIds.has(placement.placementId),
    )!;
    await database.runAsync(
      `INSERT INTO board_climbs
      (uuid, board_type, layout_id, controller_route_uuid, angle, frames, updated_at, sync_seq, is_boardsesh_authored, compatible_size_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['xl-only-source', 'quantum', 9101, ROUTE_UUID, 40, `p${xlOnly.placementId}r12`, '2026-11-19', 1, 0, '[9201]'],
    );
    const localQueries = await vi.importActual<typeof import('../../db/queries/quantum-route-presence-local')>(
      '../../db/queries/quantum-route-presence-local',
    );
    localRecovery.getDatabaseHandle.mockReturnValue(database);
    localRecovery.getRoutePresenceClimbs.mockImplementation(localQueries.getQuantumRoutePresenceClimbsLocal);
    localRecovery.getQuantumGeometry.mockImplementation(getQuantumBundledGeometry);
    controller.refresh.mockResolvedValue({
      revision: 2,
      observedAtMs: 2_000,
      players: [
        {
          routeId: ROUTE_UUID,
          userId: '20000000-0000-4000-8000-000000000099',
          remainingSeconds: 90,
          color: 0x00ff00,
        },
      ],
    });
    const view = render(provider('m'));
    try {
      await act(async () => {
        await latestActions!.connect();
      });
      expect(localRecovery.getRoutePresenceClimbs).toHaveBeenCalledWith(database, 9101, 9203, [ROUTE_UUID]);
      await expect(localRecovery.getRoutePresenceClimbs.mock.results[0]!.value).resolves.toEqual([]);
      expect(presence.reportLayersForBoard).toHaveBeenLastCalledWith(73, [
        expect.objectContaining({ climbUuid: null, angle: null, geometryKnown: false }),
      ]);
      const candidate = medium.placements[0]!;
      await expect(
        latestActions!.activateLayer({
          slot: 0,
          controllerRouteUuid: ACTIVE_ROUTE_UUID,
          diodeIds: [candidate.ledPosition],
          placementIds: [candidate.placementId],
          layoutId: 9101,
          sizeId: 9203,
          geometryGeneration: 1,
          geometryKnown: true,
        }),
      ).rejects.toThrow('diode geometry is unavailable');
      expect(controller.activate).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      database.close();
    }
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
    localRecovery.getRoutePresenceClimbs.mockResolvedValue([newerClimb]);
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
