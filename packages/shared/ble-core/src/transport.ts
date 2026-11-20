import type {
  BleCharacteristic,
  BleCharacteristicRef,
  BleOpenOptions,
  BleScheduler,
  BleTransport,
  BleWriteMode,
  BoardBleCapabilities,
  BoardBleSession,
  BoardLight,
  RolePalette,
} from './types';
import { BleError, BleSessionRuntime, bounded, defaultBleScheduler, throwIfAborted } from './session';
import { snapshotLights } from './lights';

export const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const UART_WRITE_CHARACTERISTIC_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const MAX_BLUETOOTH_MESSAGE_SIZE = 20;
export const MAX_ATT_CHUNK_SIZE = 244;
export const INTER_CHUNK_DELAY_MS = 5;
export const effectiveChunkSizeForMtu = (mtu: number) =>
  Math.min(Math.max(mtu - 3, MAX_BLUETOOTH_MESSAGE_SIZE), MAX_ATT_CHUNK_SIZE);

export function splitMessages(buffer: Uint8Array, chunkSize = MAX_BLUETOOTH_MESSAGE_SIZE): Uint8Array[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new BleError('invalid-input', 'Invalid ATT chunk size');
  return Array.from({ length: Math.ceil(buffer.length / chunkSize) }, (_, index) =>
    buffer.slice(index * chunkSize, (index + 1) * chunkSize),
  );
}

export async function findCharacteristic(
  transport: BleTransport,
  candidates: readonly BleCharacteristicRef[],
  signal?: AbortSignal,
): Promise<BleCharacteristic> {
  for (const candidate of candidates) {
    throwIfAborted(signal);
    try {
      const characteristic = await transport.getCharacteristic(candidate, signal);
      throwIfAborted(signal);
      return characteristic;
    } catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof BleError) || error.code !== 'service-missing') throw error;
    }
  }
  throw new BleError('service-missing', 'No supported write characteristic found');
}

export interface BleWriteOptions {
  chunkSize: number;
  mode: BleWriteMode;
  delayMs?: number;
  scheduler?: BleScheduler;
  shouldDelay?: () => boolean;
  writeTimeoutMs?: number;
}

export interface BleChunkSeriesOptions {
  signal?: AbortSignal;
  scheduler?: BleScheduler;
  /** Omit to skip pacing; an explicit zero still yields to a timer. */
  delayMs?: number;
  shouldDelay?: () => boolean;
  /** Existing adapters can preserve their platform's cancellation error. */
  abortError?: () => Error;
}

/**
 * Write an already split message in order. Owns pacing and abort checks only:
 * it neither re-chunks, retries, adds deadlines nor creates a session queue.
 * The callback retains platform write-mode selection and error classification.
 */
export async function writeChunkSeries(
  chunks: readonly Uint8Array[],
  writeChunk: (chunk: Uint8Array) => Promise<void>,
  options: BleChunkSeriesOptions = {},
): Promise<void> {
  const { signal } = options;
  const scheduler = options.scheduler ?? defaultBleScheduler;
  const abortError = options.abortError ?? (() => new BleError('cancelled'));
  const checkAbort = () => {
    if (signal?.aborted) throw abortError();
  };
  for (let index = 0; index < chunks.length; index++) {
    checkAbort();
    if (index > 0 && options.delayMs !== undefined && (options.shouldDelay?.() ?? true)) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          cancel();
          signal?.removeEventListener('abort', abort);
          reject(abortError());
        };
        const cancel = scheduler.setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, options.delayMs!);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    checkAbort();
    await writeChunk(chunks[index]);
  }
}

/** Raw GATT session writer; deadlines apply only when explicitly configured. */
export async function writeChunks(
  characteristic: BleCharacteristic,
  bytes: Uint8Array,
  options: BleWriteOptions,
  signal?: AbortSignal,
): Promise<void> {
  const chunks = splitMessages(bytes, options.chunkSize);
  const scheduler = options.scheduler ?? defaultBleScheduler;
  const operationSignal = signal ?? new AbortController().signal;
  await writeChunkSeries(
    chunks,
    async (chunk) => {
      const writing = characteristic.write(chunk, options.mode, operationSignal);
      if (options.writeTimeoutMs !== undefined)
        await bounded(writing, operationSignal, options.writeTimeoutMs, scheduler);
      else await writing;
    },
    {
      signal: operationSignal,
      scheduler,
      delayMs: (options.delayMs ?? 0) > 0 ? options.delayMs : undefined,
      shouldDelay: options.shouldDelay,
    },
  );
}

export interface WriteSessionOptions {
  capabilities: BoardBleCapabilities;
  characteristic: BleCharacteristic;
  encode(lights: readonly BoardLight[]): Uint8Array;
  clear(): Uint8Array;
  writeOptions: BleWriteOptions;
  maxIndex?: number;
  rolePalette?: RolePalette;
  /** Reuse the runtime that already observed disconnects during discovery. */
  runtime?: BleSessionRuntime;
}

/** Call after characteristic initialization; protocol.open owns failed-init cleanup. */
export function createWriteSession(
  transport: BleTransport,
  configuration: WriteSessionOptions,
  options: BleOpenOptions = {},
): BoardBleSession {
  if (!Number.isSafeInteger(transport.maxWriteBytes) || transport.maxWriteBytes < 1) {
    throw new BleError('invalid-input', 'Invalid ATT payload limit');
  }
  const runtime = configuration.runtime ?? new BleSessionRuntime(transport, options.scheduler);
  const write = (packet: Uint8Array, signal?: AbortSignal) =>
    runtime.run(async (operationSignal) => {
      try {
        await writeChunks(
          configuration.characteristic,
          packet,
          {
            writeTimeoutMs: 10000,
            ...configuration.writeOptions,
            chunkSize: Math.min(configuration.writeOptions.chunkSize, transport.maxWriteBytes),
            scheduler: options.scheduler ?? configuration.writeOptions.scheduler,
          },
          operationSignal,
        );
      } catch (error) {
        // A partially delivered frame must not be followed by a new frame on an uncertain link.
        await runtime.disconnect(error).catch(() => undefined);
        throw error;
      }
    }, signal);
  return {
    capabilities: configuration.capabilities,
    show(lights, signal) {
      try {
        const snapshot = snapshotLights(
          lights,
          configuration.capabilities,
          configuration.maxIndex,
          configuration.rolePalette,
        );
        const packet = new Uint8Array(configuration.encode(snapshot));
        if (packet.length === 0) throw new BleError('invalid-input', 'No LEDs encoded');
        return write(packet, signal);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    clear(signal) {
      try {
        return write(new Uint8Array(configuration.clear()), signal);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    disconnect: () => runtime.disconnect(),
    onDisconnect: (listener) => runtime.onDisconnect(listener),
  };
}
