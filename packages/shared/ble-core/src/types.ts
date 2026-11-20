/** A physical LED address, not a catalog placement or hold ID. */
export type BoardRole = 'start' | 'hand' | 'foot' | 'finish';
export type Rgb = readonly [number, number, number];
export type RolePalette = Readonly<Partial<Record<BoardRole, Rgb>>>;
export type BoardLight =
  | { readonly index: number; readonly role: BoardRole; readonly color?: never }
  | { readonly index: number; readonly color: Rgb; readonly role?: never };

export interface BoardBleCapabilities {
  readonly rgb: boolean;
  readonly roles: readonly BoardRole[];
  readonly readback: boolean;
}

export interface BoardBleSession {
  readonly capabilities: BoardBleCapabilities;
  show(lights: readonly BoardLight[], signal?: AbortSignal): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  onDisconnect(listener: () => void): () => void;
}

export type BleWriteMode = 'with-response' | 'without-response';
export interface BleCharacteristicRef {
  readonly serviceUuid: string;
  readonly characteristicUuid: string;
}

/** Each write is ONE ATT payload. Never wrap a native whole-message writer here. */
export interface BleCharacteristic {
  readonly writeWithResponse: boolean;
  readonly writeWithoutResponse: boolean;
  write(bytes: Uint8Array, mode: BleWriteMode, signal?: AbortSignal): Promise<void>;
  read?(signal?: AbortSignal): Promise<Uint8Array>;
  /** Resolves only once notifications/indications are enabled on the peripheral. */
  subscribe?(
    listener: (bytes: Uint8Array) => void,
    onError: (error: unknown) => void,
    signal?: AbortSignal,
  ): Promise<() => void>;
}

export interface BleTransport {
  readonly deviceId: string;
  readonly deviceName?: string;
  /** Negotiated ATT payload size, excluding the three-byte ATT header. */
  readonly maxWriteBytes: number;
  getCharacteristic(target: BleCharacteristicRef, signal?: AbortSignal): Promise<BleCharacteristic>;
  onDisconnect(listener: (error?: unknown) => void): () => void;
  /** Must settle after subscriptions and this connection's radio ownership are released. */
  disconnect(): Promise<void>;
}

export interface BleConnector {
  /** The caller owns permissions, discovery, chooser UI and platform connect deadlines. */
  connect(deviceId: string, signal?: AbortSignal): Promise<BleTransport>;
}

export interface BleDiscoveryProfile {
  readonly serviceUuids: readonly string[];
  readonly optionalServiceUuids?: readonly string[];
  readonly namePrefixes?: readonly string[];
}

export interface BleScheduler {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): () => void;
}

export interface BleOpenOptions {
  signal?: AbortSignal;
  scheduler?: BleScheduler;
}

export interface BoardBleProtocol<Session extends BoardBleSession = BoardBleSession> {
  readonly id: string;
  readonly discovery: BleDiscoveryProfile;
  /** Takes ownership of an already connected transport; failed initialization closes it. */
  open(transport: BleTransport, options?: BleOpenOptions): Promise<Session>;
}
