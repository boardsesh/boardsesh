import { getAuroraV3LedPacket, type AuroraV3Led } from '@boardsesh/ble-protocol/aurora';
import { effectiveChunkSizeForMtu, splitMessages } from '@boardsesh/ble-protocol/transport';
import { LedControllerError, type LedControllerDriver, type LedControllerInfo } from './types';
import { snapshotLedPixels } from './led-pixels';

/**
 * A Spraywall's LED controller over Bluetooth (docs/spray-wall-led-ble.md):
 * the board-controller firmware's gledopto-c015-spraywall build.
 *
 * The controller speaks the Aurora API v3 frames Kilter and Tension boards
 * use, over Nordic UART, with LED indices as positions. Every packet replaces
 * what is lit, as on an Aurora board, and the empty packet clears. Brightness
 * and auto-off are the controller's own settings: the protocol has no field
 * for them, so this driver ignores the wall's lighting options.
 */

/**
 * One connection to a controller, provided by the platform (the mobile app
 * builds it on react-native-ble-plx). The shared package never imports a
 * Bluetooth library.
 */
export interface BleLedLink {
  /** The ATT MTU negotiated for this connection (23 when nothing was negotiated). */
  readonly mtu: number;
  /** The name the controller advertises. */
  readonly name: string;
  /** Write one chunk to the Nordic UART write characteristic, with response. */
  write(chunk: Uint8Array): Promise<void>;
}

export interface BleLedTransport {
  /** Connect to a device, or hand back the connection already open to it. */
  connect(deviceId: string, signal?: AbortSignal): Promise<BleLedLink>;
}

export interface BleLedDriverOptions {
  /**
   * Resolved on every operation, so the app can register its transport after
   * import, or load the Bluetooth library only when a Bluetooth wall is lit.
   */
  transport: () => BleLedTransport | null | Promise<BleLedTransport | null>;
  /** Per write. Connecting gets at least 15 s: it includes service discovery. */
  timeoutMs?: number;
  /**
   * How many LEDs "Light all" sends. The protocol does not report the cable
   * length, and the controller ignores positions past its string, so this is
   * the board-controller firmware's MAX_LEDS.
   */
  lightAllLeds?: number;
}

export const DEFAULT_BLE_LIGHT_ALL_LEDS = 500;

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

export function createBleLedDriver(options: BleLedDriverOptions): LedControllerDriver {
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid BLE timeout');
  const lightAllLeds = options.lightAllLeds ?? DEFAULT_BLE_LIGHT_ALL_LEDS;

  async function connect(target: string, signal?: AbortSignal): Promise<BleLedLink> {
    const deviceId = deviceIdOf(target);
    let transport: BleLedTransport | null;
    try {
      transport = await options.transport();
    } catch {
      transport = null;
    }
    if (!transport) throw new LedControllerError('unavailable');
    return withDeadline(() => transport.connect(deviceId, signal), Math.max(timeoutMs, 15_000), signal, 'unavailable');
  }

  /** The same chunking the board adapters use: MTU-sized, framing unchanged. */
  async function send(target: string, leds: readonly AuroraV3Led[], signal?: AbortSignal) {
    const packet = getAuroraV3LedPacket(leds);
    const link = await connect(target, signal);
    for (const chunk of splitMessages(packet, effectiveChunkSizeForMtu(link.mtu))) {
      await withDeadline(() => link.write(chunk), timeoutMs, signal, 'command-failed');
    }
  }

  const white = [255, 255, 255] as const;
  const driver: LedControllerDriver = {
    normalizeTarget: normalizeBleControllerTarget,
    async probe(target, signal): Promise<LedControllerInfo> {
      const link = await connect(target, signal);
      // The protocol reports no LED count or firmware version.
      return { name: link.name.trim() || 'Spraywall', version: 'Aurora API v3', ledCount: 0 };
    },
    async lightAll(target, signal) {
      await send(
        target,
        Array.from({ length: lightAllLeds }, (_, position) => ({ position, color: white })),
        signal,
      );
    },
    async turnOff(target, signal) {
      await send(target, [], signal);
    },
    createPreview(target) {
      let mayBeLit = false;
      return {
        async show(indices, pixels) {
          const pixelSnapshot = snapshotLedPixels(indices, pixels);
          if (indices.some((index) => index > 0xffff)) throw new LedControllerError('invalid-indices');
          const byIndex = new Map((pixelSnapshot ?? []).map((pixel) => [pixel.index, pixel.color]));
          // Each packet replaces what is lit, so no blanking of the previous LEDs.
          const leds = [...new Set(indices)].map((position) => ({
            position,
            color: byIndex.get(position) ?? white,
          }));
          mayBeLit = true;
          await send(target, leds);
        },
        async lightAll() {
          mayBeLit = true;
          await driver.lightAll(target);
        },
        async turnOff() {
          if (!mayBeLit) return;
          await driver.turnOff(target);
          mayBeLit = false;
        },
      };
    },
  };
  return driver;
}

type TransportSource = BleLedTransport | (() => Promise<BleLedTransport>) | null;
let registeredTransport: TransportSource = null;

/**
 * The app registers its Bluetooth transport, or a loader for it, once; until
 * then every operation is `unavailable`.
 */
export function registerBleLedTransport(transport: TransportSource): void {
  registeredTransport = transport;
}

export const bleLedDriver = createBleLedDriver({
  transport: () => (typeof registeredTransport === 'function' ? registeredTransport() : registeredTransport),
});
