import {
  BleError,
  BleSessionRuntime,
  findCharacteristic,
  resolveRgb,
  snapshotLights,
  writeChunks,
  type BleCharacteristic,
  type BleOpenOptions,
  type BleTransport,
  type BoardBleCapabilities,
  type BoardBleProtocol,
  type BoardBleSession,
  type BoardLight,
  type BoardRole,
  type RolePalette,
} from '@boardsesh/ble-core';
import { encodeAuroraClear, encodeAuroraEntries, rgbToHex, type AuroraEncodeOptions } from './codec';
import { isKilterBuiltBox, parseApiLevel } from './identity';

export const AURORA_ADVERTISED_SERVICE_UUID = '4488b571-7806-4df6-bcff-a2897e4953ff';
export const AURORA_UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const AURORA_WRITE_CHARACTERISTIC_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const AURORA_WRITE_CHARACTERISTIC = {
  serviceUuid: AURORA_UART_SERVICE_UUID,
  characteristicUuid: AURORA_WRITE_CHARACTERISTIC_UUID,
} as const;

export interface AuroraProtocolOptions extends AuroraEncodeOptions {
  /** Explicit wire colors for semantic roles; RGB entries never need a palette. */
  rolePalette?: RolePalette;
  /** By default selected from the advertised name, independently of the board brand. */
  writeProfile?: 'aurora' | 'kilter-built';
}

export class AuroraProtocolError extends Error {
  constructor(public readonly code: 'all-leds-dark') {
    super(code);
    this.name = 'AuroraProtocolError';
  }
}

const roles: readonly BoardRole[] = ['start', 'hand', 'foot', 'finish'];

function capabilitiesForPalette(palette?: RolePalette): BoardBleCapabilities {
  return {
    rgb: true,
    roles: roles.filter((role) => palette?.[role] !== undefined),
    readback: false,
  };
}

function snapshotPalette(palette?: RolePalette): RolePalette | undefined {
  if (!palette) return undefined;
  const snapshot: Partial<Record<BoardRole, readonly [number, number, number]>> = {};
  for (const role of roles) {
    const color = palette[role];
    if (color) snapshot[role] = [color[0], color[1], color[2]];
  }
  return snapshot;
}

function validateOptions({ apiLevel, ledsPerHold }: AuroraEncodeOptions): void {
  if (apiLevel !== undefined && (!Number.isSafeInteger(apiLevel) || apiLevel < 1)) {
    throw new RangeError('Aurora API level must be a positive integer');
  }
  if (ledsPerHold !== undefined && (!Number.isSafeInteger(ledsPerHold) || ledsPerHold < 1)) {
    throw new RangeError('Aurora LEDs per hold must be a positive integer');
  }
}

/** Strict, physical-address input for portable clients; the lower-level codec retains skip diagnostics. */
export function encodeAuroraLights(lights: readonly BoardLight[], options: AuroraProtocolOptions = {}) {
  validateOptions(options);
  const apiLevel = options.apiLevel ?? 3;
  const snapshot = snapshotLights(
    lights,
    capabilitiesForPalette(options.rolePalette),
    apiLevel < 3 ? 1023 : 65535,
    options.rolePalette,
  );
  return encodeAuroraEntries(
    snapshot.map((light) => ({ position: light.index, color: rgbToHex(resolveRgb(light, options.rolePalette)) })),
    options,
  );
}

function isUnsupportedWrite(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotSupportedError';
}

async function openAuroraSession(
  transport: BleTransport,
  options: AuroraProtocolOptions,
  openOptions: BleOpenOptions = {},
): Promise<BoardBleSession> {
  const runtime = new BleSessionRuntime(transport, openOptions.scheduler);
  try {
    const apiLevel = options.apiLevel ?? parseApiLevel(transport.deviceName);
    validateOptions({ ...options, apiLevel });
    const characteristic = await runtime.run(
      (signal) => findCharacteristic(transport, [AURORA_WRITE_CHARACTERISTIC], signal),
      openOptions.signal,
    );
    if (!Number.isSafeInteger(transport.maxWriteBytes) || transport.maxWriteBytes < 20) {
      throw new BleError('invalid-input', 'ATT payload size must be at least 20 bytes');
    }
    const profile = options.writeProfile ?? (isKilterBuiltBox(transport.deviceName) ? 'kilter-built' : 'aurora');
    if (profile === 'kilter-built' && !characteristic.writeWithResponse) {
      throw new BleError('unsupported', 'Kilter-built controllers require acknowledged writes');
    }
    const capabilities = capabilitiesForPalette(options.rolePalette);
    const chunkSize = profile === 'kilter-built' ? 20 : Math.min(244, Math.max(20, transport.maxWriteBytes));
    const write = async (packet: Uint8Array, signal: AbortSignal): Promise<void> => {
      let acceptedChunks = 0;
      const trackedCharacteristic: BleCharacteristic = {
        writeWithResponse: characteristic.writeWithResponse,
        writeWithoutResponse: characteristic.writeWithoutResponse,
        async write(bytes, mode, writeSignal) {
          await characteristic.write(bytes, mode, writeSignal);
          acceptedChunks++;
        },
      };
      const writeOptions = {
        chunkSize,
        mode: profile === 'kilter-built' ? ('with-response' as const) : ('without-response' as const),
        delayMs: profile === 'kilter-built' ? 100 : 5,
        scheduler: openOptions.scheduler,
        writeTimeoutMs: 10000,
      };
      try {
        // Serial-bearing Aurora controllers can under-report the no-response
        // property. Keep their proven profile; actual NotSupportedError is the gate.
        await writeChunks(trackedCharacteristic, packet, writeOptions, signal);
      } catch (error) {
        // Some browser transports report a write-only box only when a no-response
        // write is attempted. Never replay on timeouts or other ambiguous failures.
        if (
          profile === 'kilter-built' ||
          acceptedChunks > 0 ||
          !characteristic.writeWithResponse ||
          !isUnsupportedWrite(error)
        )
          throw error;
        await writeChunks(
          characteristic,
          packet,
          {
            chunkSize: 20,
            mode: 'with-response',
            delayMs: 5,
            scheduler: openOptions.scheduler,
            writeTimeoutMs: 10000,
          },
          signal,
        );
      }
    };
    const send = (packet: Uint8Array, signal?: AbortSignal) =>
      runtime.run(async (operationSignal) => {
        try {
          await write(packet, operationSignal);
        } catch (error) {
          // Never send another logical frame after a partial/ambiguous write.
          await runtime.disconnect(error).catch(() => undefined);
          throw error;
        }
      }, signal);
    return {
      capabilities,
      show(lights, signal) {
        try {
          // Resolve and copy input before joining the queue, so neither mutable
          // caller arrays nor palette objects can change a queued command.
          const encoded = encodeAuroraLights(lights, { ...options, apiLevel });
          if (encoded.allLedsDark) throw new AuroraProtocolError('all-leds-dark');
          return send(encoded.packet, signal);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      clear: (signal) => send(encodeAuroraClear(apiLevel), signal),
      disconnect: () => runtime.disconnect(),
      onDisconnect: (listener) => runtime.onDisconnect(listener),
    };
  } catch (error) {
    await runtime.disconnect(error).catch(() => undefined);
    throw error;
  }
}

/** A write-only Aurora connection over an injected raw GATT transport. */
export function createAuroraProtocol(options: AuroraProtocolOptions = {}): BoardBleProtocol {
  validateOptions(options);
  const configuration = { ...options, rolePalette: snapshotPalette(options.rolePalette) };
  return {
    id: 'aurora',
    discovery: {
      serviceUuids: [AURORA_ADVERTISED_SERVICE_UUID],
      optionalServiceUuids: [AURORA_UART_SERVICE_UUID],
    },
    open: (transport, openOptions) => openAuroraSession(transport, configuration, openOptions),
  };
}
