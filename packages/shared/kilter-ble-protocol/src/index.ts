import {
  createAuroraProtocol,
  encodeAuroraLights,
  parseBoardTypeFromDeviceName,
  type AuroraProtocolOptions,
} from '@boardsesh/aurora-ble-protocol';
import type { BoardBleProtocol, BoardLight } from '@boardsesh/ble-core';

export type KilterProtocolOptions = Omit<AuroraProtocolOptions, 'ledsPerHold'>;

export function isKilterDeviceName(deviceName?: string): boolean {
  return parseBoardTypeFromDeviceName(deviceName) === 'kilter';
}

/** Kilter addresses power two LEDs; encoding and controller profiles remain Aurora's. */
export function createKilterProtocol(options: KilterProtocolOptions = {}): BoardBleProtocol {
  const aurora = createAuroraProtocol({ ...options, ledsPerHold: 2 });
  return { ...aurora, id: 'kilter' };
}

export function encodeKilterLights(lights: readonly BoardLight[], options: KilterProtocolOptions = {}) {
  return encodeAuroraLights(lights, { ...options, ledsPerHold: 2 });
}

export {
  encodeAuroraClear as encodeKilterClear,
  parseApiLevel,
  parseSerialNumber,
} from '@boardsesh/aurora-ble-protocol';
