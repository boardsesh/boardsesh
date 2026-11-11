import {
  LedControllerError,
  resolveLedLightingOptions,
  type LedControllerDriver,
  type LedControllerInfo,
} from './types';
import { snapshotLedPixels } from './led-pixels';
import {
  BLE_LED_PROTOCOL_VERSION,
  BLE_LED_STATUS,
  BleLedProtocolError,
  bleLedRunsPerFrame,
  chunkBleLedRuns,
  decodeBleLedInfo,
  decodeBleLedStatus,
  encodeAutoOff,
  encodeLightAll,
  encodeOff,
  encodePreviewBegin,
  encodeSetPixels,
  encodeWake,
  toBleLedRuns,
  type BleLedInfo,
} from './wled-ble-protocol';

/**
 * One connection to a controller, provided by the platform (the mobile app
 * builds it on react-native-ble-plx). The shared package never imports a
 * Bluetooth library.
 */
export interface BleLedLink {
  /** The ATT MTU negotiated for this connection (23 when nothing was negotiated). */
  readonly mtu: number;
  /** Read the info characteristic. */
  readInfo(): Promise<Uint8Array>;
  /** Write one frame to the control characteristic, with response. */
  writeControl(frame: Uint8Array): Promise<void>;
  /** Listen to status notifications. Returns the unsubscribe. */
  onStatus(listener: (frame: Uint8Array) => void): () => void;
}

export interface BleLedTransport {
  /** Connect to a device, or hand back the connection already open to it. */
  connect(deviceId: string, signal?: AbortSignal): Promise<BleLedLink>;
}

export interface WledBleDriverOptions {
  /** Resolved on every operation, so the app can register its transport after import. */
  transport: () => BleLedTransport | null;
  /** Per exchange (connect, read, or one frame and its status). */
  timeoutMs?: number;
}

const TARGET_PREFIX = 'ble:';
const DEVICE_ID = /^[A-Za-z0-9:_-]{1,128}$/u;

/** The controller "address" a Bluetooth wall is driven at: `ble:<device id>`. */
export function bleControllerTarget(deviceId: string): string {
  if (!DEVICE_ID.test(deviceId)) throw new LedControllerError('invalid-url');
  return `${TARGET_PREFIX}${deviceId}`;
}

export function normalizeBleControllerTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed.startsWith(TARGET_PREFIX)) throw new LedControllerError('invalid-url');
  return bleControllerTarget(trimmed.slice(TARGET_PREFIX.length));
}

function deviceIdOf(target: string): string {
  return normalizeBleControllerTarget(target).slice(TARGET_PREFIX.length);
}

/** Settle `operation` within the timeout, or reject with `timeout` / `cancelled`. */
async function withDeadline<Result>(
  operation: () => Promise<Result>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  failure: LedControllerError['code'],
): Promise<Result> {
  if (signal?.aborted) throw new LedControllerError('cancelled');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onCancel: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onCancel = () => reject(new LedControllerError('cancelled'));
    signal?.addEventListener('abort', onCancel, { once: true });
    timeout = setTimeout(() => reject(new LedControllerError('timeout')), timeoutMs);
  });
  const attempt = (async () => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof LedControllerError) throw error;
      throw new LedControllerError(failure);
    }
  })();
  // A late rejection after the deadline won must not become unhandled.
  attempt.catch(() => undefined);
  try {
    return await Promise.race([attempt, interrupted]);
  } finally {
    clearTimeout(timeout);
    if (onCancel) signal?.removeEventListener('abort', onCancel);
  }
}

export function createWledBleDriver(options: WledBleDriverOptions): LedControllerDriver {
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid BLE timeout');
  let sequence = 0;

  async function connect(target: string, signal?: AbortSignal): Promise<BleLedLink> {
    const deviceId = deviceIdOf(target);
    const transport = options.transport();
    if (!transport) throw new LedControllerError('unavailable');
    // Connecting includes discovery and, the first time, the OS pairing prompt.
    return withDeadline(() => transport.connect(deviceId, signal), Math.max(timeoutMs, 15_000), signal, 'unavailable');
  }

  async function readInfo(link: BleLedLink, signal?: AbortSignal): Promise<BleLedInfo> {
    const bytes = await withDeadline(() => link.readInfo(), timeoutMs, signal, 'unavailable');
    let info: BleLedInfo;
    try {
      info = decodeBleLedInfo(bytes);
    } catch (error) {
      if (error instanceof BleLedProtocolError) throw new LedControllerError('not-wled');
      throw error;
    }
    if (info.protocolVersion !== BLE_LED_PROTOCOL_VERSION) throw new LedControllerError('unsupported-version');
    if (info.ledCount <= 0 || !info.name.trim()) throw new LedControllerError('not-wled');
    return info;
  }

  /** Write one frame and wait for the controller to say it applied it. */
  async function exchange(link: BleLedLink, build: (sequence: number) => Uint8Array, signal?: AbortSignal) {
    sequence = (sequence + 1) & 0xff;
    const frame = build(sequence);
    const expected = frame[2];
    let unsubscribe: (() => void) | undefined;
    try {
      await withDeadline(
        () =>
          new Promise<void>((resolve, reject) => {
            unsubscribe = link.onStatus((bytes) => {
              let status;
              try {
                status = decodeBleLedStatus(bytes);
              } catch {
                return;
              }
              if (status.sequence !== expected) return;
              if (status.result === BLE_LED_STATUS.ok) resolve();
              else if (status.result === BLE_LED_STATUS.outOfRange) reject(new LedControllerError('invalid-indices'));
              else if (status.result === BLE_LED_STATUS.unsupportedVersion) {
                reject(new LedControllerError('unsupported-version'));
              } else reject(new LedControllerError('command-failed'));
            });
            link.writeControl(frame).catch(() => reject(new LedControllerError('command-failed')));
          }),
        timeoutMs,
        signal,
        'command-failed',
      );
    } finally {
      unsubscribe?.();
    }
  }

  const driver: LedControllerDriver = {
    normalizeTarget: normalizeBleControllerTarget,
    async probe(target, signal): Promise<LedControllerInfo> {
      const info = await readInfo(await connect(target, signal), signal);
      return { name: info.name, version: info.version, ledCount: info.ledCount };
    },
    async lightAll(target, signal, lighting) {
      const { brightness, autoOffMinutes } = resolveLedLightingOptions(lighting);
      const link = await connect(target, signal);
      await readInfo(link, signal);
      await exchange(link, (next) => encodeLightAll(next, brightness, autoOffMinutes), signal);
    },
    async turnOff(target, signal) {
      const link = await connect(target, signal);
      await exchange(link, (next) => encodeOff(next), signal);
    },
    createPreview(target, lighting) {
      const { brightness, autoOffMinutes } = resolveLedLightingOptions(lighting);
      let count: number | null = null;
      let previous: number[] = [];
      let mayBeLit = false;
      return {
        async show(indices, pixels) {
          const pixelSnapshot = snapshotLedPixels(indices, pixels);
          const next = [...new Set(indices)];
          const link = await connect(target);
          const info = await readInfo(link);
          // Switched off since the last write (WLED's UI, its button, the
          // auto-off): individual colours would stay dark, so wake it again.
          if (count !== null && !info.lit) {
            count = null;
            previous = [];
          }
          if (next.some((index) => index >= info.ledCount)) throw new LedControllerError('invalid-indices');
          if (count === null) {
            mayBeLit = true;
            await exchange(link, (sequence) => encodePreviewBegin(sequence, brightness));
          } else if (autoOffMinutes > 0) {
            // Stop the old timer so the countdown runs from this write.
            await exchange(link, (sequence) => encodeWake(sequence, brightness));
          }
          const colors = new Map<number, readonly [number, number, number]>();
          // A fresh preview starts black, so only a running one blanks the old LEDs.
          if (count !== null) for (const index of previous) colors.set(index, [0, 0, 0]);
          const byIndex = new Map((pixelSnapshot ?? []).map((pixel) => [pixel.index, pixel.color]));
          for (const index of next) colors.set(index, byIndex.get(index) ?? [255, 255, 255]);
          const runsPerFrame = bleLedRunsPerFrame(link.mtu, info.maxFrameBytes);
          if (runsPerFrame < 1) throw new LedControllerError('command-failed');
          for (const runs of chunkBleLedRuns(toBleLedRuns(colors), runsPerFrame)) {
            await exchange(link, (sequence) => encodeSetPixels(sequence, runs));
          }
          if (autoOffMinutes > 0) await exchange(link, (sequence) => encodeAutoOff(sequence, autoOffMinutes));
          count = info.ledCount;
          previous = next;
        },
        async lightAll() {
          count = null;
          previous = [];
          mayBeLit = true;
          await driver.lightAll(target, undefined, lighting);
        },
        async turnOff() {
          if (!mayBeLit) return;
          count = null;
          previous = [];
          await driver.turnOff(target);
          mayBeLit = false;
        },
      };
    },
  };
  return driver;
}

let registeredTransport: BleLedTransport | null = null;

/** The app registers its Bluetooth transport once; until then every operation is `unavailable`. */
export function registerWledBleTransport(transport: BleLedTransport | null): void {
  registeredTransport = transport;
}

export const wledBleDriver = createWledBleDriver({ transport: () => registeredTransport });
