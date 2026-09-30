import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { SCAN_TIMEOUT_MS } from '@boardsesh/ble-protocol/scan-constants';
import type { ActiveBoard } from '../board/active-board';
import { useBoard } from '../board/board-provider';
import { readJson, writeJson } from '../storage/json-storage';
import { checkBluetooth, getBleManager, type BluetoothAvailability } from './ble-manager';
import { BoardConnection, scanForBoards, type DiscoveredBoard } from './board-connection';
import { boardFamily } from './device-filter';
import { buildBoardPacket } from './packets';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type ShowClimbResult = 'lit' | 'notConnected' | 'incompatible' | 'failed';

type BluetoothContextValue = {
  status: ConnectionStatus;
  /** The connected controller's advertised name. */
  deviceName: string | null;
  scanning: boolean;
  /** Boards heard in the current scan. */
  devices: DiscoveredBoard[];
  /** Something the climber should know: Bluetooth off, a failed connect, a dropped link. */
  problem: string | null;
  startScan: () => Promise<void>;
  stopScan: () => void;
  connect: (device: DiscoveredBoard) => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Light a climb's holds. Screens call it again when the status changes, so
   * a climb on screen lights up as soon as the board connects.
   */
  showClimb: (frames: string) => Promise<ShowClimbResult>;
};

const KEEP_AWAKE_TAG = 'boardz-board-connection';

const AVAILABILITY_PROBLEMS: Record<Exclude<BluetoothAvailability, 'ready'>, string> = {
  off: 'Bluetooth is off. Turn it on in Control Center, then try again.',
  unauthorized: 'Boardz is not allowed to use Bluetooth. Turn it on in Settings › Boardz.',
  unsupported: 'This phone does not support Bluetooth Low Energy.',
  notReady: "Bluetooth isn't ready yet. Try again in a moment.",
};

type RememberedDevice = { id: string; name: string | null };

function isRememberedDevice(value: unknown): value is RememberedDevice {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && (candidate.name === null || typeof candidate.name === 'string');
}

/** Which physical wall this is, for remembering its controller. */
function rememberedDeviceKey(board: ActiveBoard): string {
  return `boardz.ble.device.${board.boardName}:${board.layoutId}:${board.sizeId}:${board.boardUuid ?? ''}`;
}

/** What a connection is valid for. The hold sets change the LED map; the angle does not. */
function connectionKey(board: ActiveBoard | null): string {
  if (!board) return '';
  return `${board.boardName}:${board.layoutId}:${board.sizeId}:${board.setIds.join(',')}:${board.boardUuid ?? ''}`;
}

const BluetoothContext = createContext<BluetoothContextValue | null>(null);

export function BluetoothProvider({ children }: { children: ReactNode }) {
  const { board } = useBoard();
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<DiscoveredBoard[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const boardRef = useRef(board);
  const connectionRef = useRef<BoardConnection | null>(null);
  const connectedKeyRef = useRef('');
  const connectingRef = useRef(false);
  const stopScanRef = useRef<(() => void) | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every stop, so a scan still starting up knows it was cancelled.
  const scanGenerationRef = useRef(0);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  // Creating the manager shows iOS's Bluetooth prompt. Doing it once there's a
  // board puts the prompt right after board setup and settles Bluetooth
  // before the first Connect tap.
  const hasBoard = board !== null;
  useEffect(() => {
    if (hasBoard) getBleManager();
  }, [hasBoard]);

  const stopScan = () => {
    scanGenerationRef.current += 1;
    stopScanRef.current?.();
    stopScanRef.current = null;
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = null;
    setScanning(false);
  };

  const dropConnection = async () => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    connectedKeyRef.current = '';
    setStatus('disconnected');
    setDeviceName(null);
    await connection?.disconnect();
  };

  const sendFrames = async (
    connection: BoardConnection,
    target: ActiveBoard,
    frames: string,
  ): Promise<ShowClimbResult> => {
    const result = buildBoardPacket(target, frames, connection.deviceName);
    if (result.kind === 'incompatible') return 'incompatible';
    try {
      await connection.write(result.packet);
      return 'lit';
    } catch {
      return 'failed';
    }
  };

  const connect = async (device: DiscoveredBoard) => {
    const target = boardRef.current;
    if (!target || connectingRef.current) return;
    connectingRef.current = true;
    stopScan();
    await dropConnection();
    setProblem(null);
    setStatus('connecting');

    const connection = new BoardConnection(device.id, device.name, boardFamily(target.boardName), () => {
      if (connectionRef.current !== connection) return;
      connectionRef.current = null;
      connectedKeyRef.current = '';
      setStatus('disconnected');
      setDeviceName(null);
      setProblem('Lost the connection to your board. Connect again to keep lighting climbs.');
    });
    connectionRef.current = connection;

    try {
      await connection.connect();
    } catch (error) {
      // A connection dropped on purpose (another board picked) isn't a problem.
      if (connectionRef.current === connection) {
        connectionRef.current = null;
        setStatus('disconnected');
        setProblem(error instanceof Error ? error.message : 'Could not connect to the board.');
      }
      return;
    } finally {
      connectingRef.current = false;
    }

    if (connectionRef.current !== connection) return;
    connectedKeyRef.current = connectionKey(target);
    setStatus('connected');
    setDeviceName(connection.deviceName);
    writeJson(rememberedDeviceKey(target), {
      id: device.id,
      name: connection.deviceName,
    } satisfies RememberedDevice);
  };

  const startScan = async () => {
    const target = boardRef.current;
    if (!target) return;
    stopScan();
    const generation = scanGenerationRef.current;
    setProblem(null);
    setDevices([]);
    setScanning(true);

    const availability = await checkBluetooth();
    if (generation !== scanGenerationRef.current) return;
    if (availability !== 'ready') {
      setScanning(false);
      setProblem(AVAILABILITY_PROBLEMS[availability]);
      return;
    }

    // Reconnect to this wall's controller as soon as it shows up.
    const remembered = await readJson(rememberedDeviceKey(target), isRememberedDevice);
    if (generation !== scanGenerationRef.current) return;
    const family = boardFamily(target.boardName);
    stopScanRef.current = scanForBoards(
      family,
      (found) => {
        setDevices(found);
        const seen = remembered ? found.find((device) => device.id === remembered.id) : undefined;
        if (!seen || connectionRef.current !== null) return;
        const name = seen.name ?? remembered?.name ?? null;
        // Aurora packets take their version from the name, so wait for it.
        if (family === 'aurora' && name === null) return;
        void connect({ ...seen, name });
      },
      (message) => {
        setProblem(message);
        stopScan();
      },
    );
    scanTimerRef.current = setTimeout(stopScan, SCAN_TIMEOUT_MS);
  };

  const disconnect = async () => {
    stopScan();
    await dropConnection();
  };

  const showClimb = async (frames: string): Promise<ShowClimbResult> => {
    const connection = connectionRef.current;
    const target = boardRef.current;
    if (!connection?.isConnected || !target) return 'notConnected';
    return sendFrames(connection, target, frames);
  };

  // Another board, or different hold sets: this controller no longer matches.
  const currentKey = connectionKey(board);
  // Keyed on the board identity only: dropConnection touches nothing but refs and state setters.
  useEffect(() => {
    if (connectionRef.current && connectedKeyRef.current !== currentKey) void dropConnection();
  }, [currentKey]);

  // Keep the screen on while a board is connected, like the official apps.
  useEffect(() => {
    if (status !== 'connected') return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [status]);

  useEffect(
    () => () => {
      stopScanRef.current?.();
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
      void connectionRef.current?.disconnect();
    },
    [],
  );

  const value: BluetoothContextValue = {
    status,
    deviceName,
    scanning,
    devices,
    problem,
    startScan,
    stopScan,
    connect,
    disconnect,
    showClimb,
  };

  return <BluetoothContext.Provider value={value}>{children}</BluetoothContext.Provider>;
}

export function useBluetooth(): BluetoothContextValue {
  const context = useContext(BluetoothContext);
  if (!context) throw new Error('useBluetooth must be used inside BluetoothProvider');
  return context;
}
