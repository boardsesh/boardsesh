export const QUANTUM_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const QUANTUM_LEGACY_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const QUANTUM_SERVICE_UUIDS = [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID] as const;
export const QUANTUM_NOTIFY_CHARACTERISTIC_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
export const QUANTUM_WRITE_CHARACTERISTIC_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';
export const QUANTUM_STATE_CHARACTERISTIC_UUID = '0000fff4-0000-1000-8000-00805f9b34fb';
export const QUANTUM_METADATA_CHARACTERISTIC_UUID = '0000fff5-0000-1000-8000-00805f9b34fb';

export const QUANTUM_REQUESTED_MTU = 512;
export const QUANTUM_ATT_HEADER_BYTES = 3;
/** Boardsesh supports four layers; firmware roster capacity is unknown. */
export const QUANTUM_MAX_PLAYERS = 4;
export const QUANTUM_MAX_DIODE_IDS = 92;
export const QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS = 0xffff;
export const QUANTUM_ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export const QUANTUM_DEVICE_NAME_PREFIXES = ['QB_', 'QBB_'] as const;

export const QuantumCommand = {
  ACTIVATE_WALL: 0x41,
  TURN_OFF_BY_ROUTE: 0x42,
  TURN_OFF_BY_USER: 0x43,
  BOARD_SWIPE: 0x44,
  TURN_OFF_ALL: 0x45,
  REQUEST_USER_ROUTE_LIST: 0x47,
  TURN_ON_ALL: 0x64,
} as const;

export type QuantumCommand = (typeof QuantumCommand)[keyof typeof QuantumCommand];

export type QuantumBoardModelId = 'xl' | 'l' | 'm' | 's' | 'belay';

export type QuantumBoardModel = {
  id: QuantumBoardModelId;
  displayName: string;
  controllerType: number;
  columns: number;
  rows: number;
};

export const QUANTUM_BOARD_MODELS = {
  xl: { id: 'xl', displayName: 'XL', controllerType: 0, columns: 15, rows: 15 },
  l: { id: 'l', displayName: 'L', controllerType: 4, columns: 15, rows: 12 },
  m: { id: 'm', displayName: 'M', controllerType: 1, columns: 12, rows: 12 },
  s: { id: 's', displayName: 'S Fitness', controllerType: 2, columns: 8, rows: 12 },
  belay: { id: 'belay', displayName: 'Belay Board', controllerType: 3, columns: 8, rows: 12 },
} as const satisfies Record<QuantumBoardModelId, QuantumBoardModel>;

export const QUANTUM_MODELS: readonly QuantumBoardModel[] = Object.values(QUANTUM_BOARD_MODELS);
