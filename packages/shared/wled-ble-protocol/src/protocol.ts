export const WLED_BLE_SERVICE_UUID = '2f8d0001-6f6e-4c9d-9b74-8a3d41c3a201';
export const WLED_BLE_CAPABILITIES_UUID = '2f8d0002-6f6e-4c9d-9b74-8a3d41c3a201';
export const WLED_BLE_REQUEST_UUID = '2f8d0003-6f6e-4c9d-9b74-8a3d41c3a201';
export const WLED_BLE_RESPONSE_UUID = '2f8d0004-6f6e-4c9d-9b74-8a3d41c3a201';
export const WLED_BLE_PROTOCOL_VERSION = 1;
export const WLED_BLE_MAX_MESSAGE_BYTES = 8192;
export const WLED_BLE_FRAGMENT_TIMEOUT_MS = 5000;
export const WLED_BLE_IDLE_TIMEOUT_MS = 15000;

export class WledBleProtocolError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'WledBleProtocolError';
  }
}

export interface WledBleCapabilities {
  controllerId: string;
  protocolVersion: 1;
  name: string;
  wledVersion: string;
  usermodVersion?: string;
  buildId?: string;
  ledCount: number;
  audio: boolean;
  maxMessageBytes: number;
}
export type WledBleOperation = 'getInfo' | 'getState' | 'setState';
export type WledBleRequest =
  | { id: string; op: 'getInfo' | 'getState' }
  | { id: string; op: 'setState'; state: Record<string, unknown> };
export type WledBleResponse =
  | { id: string; result: unknown }
  | { id: string; error: { code: string; message?: string } };

/** One already discovered, identity-checked connection. Native code owns the radio. */
export interface WledBleConnection {
  capabilities: WledBleCapabilities;
  request(op: WledBleOperation, state?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  disconnect(): Promise<void>;
}
export interface WledBleConnector {
  connect(controllerId: string, signal?: AbortSignal): Promise<WledBleConnection>;
}

export function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}
function integer(candidate: unknown, min: number, max: number): candidate is number {
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= min && candidate <= max;
}
function nonempty(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.trim().length > 0;
}
export function parseCapabilities(payload: unknown): WledBleCapabilities {
  if (
    !isRecord(payload) ||
    !nonempty(payload.controllerId) ||
    !/^wled-[0-9a-f]{12}$/.test(payload.controllerId) ||
    payload.protocolVersion !== 1 ||
    !nonempty(payload.name) ||
    !nonempty(payload.wledVersion) ||
    !integer(payload.ledCount, 1, 65535) ||
    typeof payload.audio !== 'boolean' ||
    !integer(payload.maxMessageBytes, 1, WLED_BLE_MAX_MESSAGE_BYTES) ||
    (payload.usermodVersion !== undefined && !nonempty(payload.usermodVersion)) ||
    (payload.buildId !== undefined && !nonempty(payload.buildId))
  )
    throw new WledBleProtocolError('invalid-capabilities');
  return payload as unknown as WledBleCapabilities;
}

/** UTF-8 is explicit: no Buffer, DOM, Expo or React Native dependency. */
export function encodeUtf8(message: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of message) {
    const codepoint = character.codePointAt(0)!;
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) throw new WledBleProtocolError('invalid-utf8');
    if (codepoint < 0x80) bytes.push(codepoint);
    else if (codepoint < 0x800) bytes.push(0xc0 | (codepoint >> 6), 0x80 | (codepoint & 63));
    else if (codepoint < 0x10000)
      bytes.push(0xe0 | (codepoint >> 12), 0x80 | ((codepoint >> 6) & 63), 0x80 | (codepoint & 63));
    else
      bytes.push(
        0xf0 | (codepoint >> 18),
        0x80 | ((codepoint >> 12) & 63),
        0x80 | ((codepoint >> 6) & 63),
        0x80 | (codepoint & 63),
      );
  }
  return Uint8Array.from(bytes);
}
export function decodeUtf8(bytes: Uint8Array): string {
  let decoded = '';
  for (let offset = 0; offset < bytes.length;) {
    const first = bytes[offset++];
    const width =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
    if (!width || offset + width - 1 > bytes.length) throw new WledBleProtocolError('invalid-utf8');
    let codepoint = first & (width === 1 ? 0x7f : (1 << (7 - width)) - 1);
    for (let continuation = 1; continuation < width; continuation++) {
      const next = bytes[offset++];
      if ((next & 0xc0) !== 0x80) throw new WledBleProtocolError('invalid-utf8');
      codepoint = (codepoint << 6) | (next & 63);
    }
    if (
      (width > 1 && codepoint < [0, 0, 0x80, 0x800, 0x10000][width]) ||
      codepoint > 0x10ffff ||
      (codepoint >= 0xd800 && codepoint <= 0xdfff)
    )
      throw new WledBleProtocolError('invalid-utf8');
    decoded += String.fromCodePoint(codepoint);
  }
  return decoded;
}

export function encodeFrame(payload: unknown, limit = WLED_BLE_MAX_MESSAGE_BYTES): Uint8Array {
  if (!integer(limit, 1, WLED_BLE_MAX_MESSAGE_BYTES)) throw new WledBleProtocolError('invalid-message-limit');
  const json = JSON.stringify(payload);
  if (json === undefined) throw new WledBleProtocolError('invalid-json');
  const bytes = encodeUtf8(json);
  if (bytes.length < 1 || bytes.length > Math.min(limit, WLED_BLE_MAX_MESSAGE_BYTES))
    throw new WledBleProtocolError('message-too-large');
  const frame = new Uint8Array(bytes.length + 4);
  new DataView(frame.buffer).setUint32(0, bytes.length, true);
  frame.set(bytes, 4);
  return frame;
}
export function fragmentFrame(frame: Uint8Array, payloadBytes = 20): Uint8Array[] {
  if (!integer(payloadBytes, 1, 512)) throw new WledBleProtocolError('invalid-mtu');
  const fragments: Uint8Array[] = [];
  for (let offset = 0; offset < frame.length; offset += payloadBytes)
    fragments.push(frame.slice(offset, offset + payloadBytes));
  return fragments;
}

/** A connection owns one assembler; reset it on disconnect and never reuse old fragments. */
export class WledBleFrameAssembler {
  private readonly bytes = new Uint8Array(WLED_BLE_MAX_MESSAGE_BYTES + 4);
  private received = 0;
  private expected = 0;
  private lastFragmentAt = 0;
  reset(): void {
    this.received = 0;
    this.expected = 0;
    this.lastFragmentAt = 0;
  }
  expire(now: number): boolean {
    if (this.received && now - this.lastFragmentAt >= WLED_BLE_FRAGMENT_TIMEOUT_MS) {
      this.reset();
      return true;
    }
    return false;
  }
  push(fragment: Uint8Array, now = Date.now()): Record<string, unknown> | null {
    if (this.expire(now)) throw new WledBleProtocolError('fragment-timeout');
    if (!fragment.length) throw new WledBleProtocolError('empty-fragment');
    try {
      if (this.received + fragment.length > this.bytes.length) throw new WledBleProtocolError('message-too-large');
      this.bytes.set(fragment, this.received);
      this.received += fragment.length;
      this.lastFragmentAt = now;
      if (!this.expected && this.received >= 4) {
        const length = new DataView(this.bytes.buffer).getUint32(0, true);
        if (!length || length > WLED_BLE_MAX_MESSAGE_BYTES) throw new WledBleProtocolError('invalid-length');
        this.expected = length + 4;
      }
      if (!this.expected || this.received < this.expected) return null;
      if (this.received !== this.expected) throw new WledBleProtocolError('trailing-bytes');
      const json = decodeUtf8(this.bytes.subarray(4, this.expected));
      this.reset();
      let payload: unknown;
      try {
        payload = JSON.parse(json) as unknown;
      } catch {
        throw new WledBleProtocolError('invalid-json');
      }
      if (!isRecord(payload)) throw new WledBleProtocolError('invalid-message');
      return payload;
    } catch (error) {
      this.reset();
      throw error;
    }
  }
}

export function parseRequest(payload: unknown, ledCount: number): WledBleRequest {
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,64}$/.test(payload.id) ||
    Object.keys(payload).some((key) => !['id', 'op', 'state'].includes(key))
  )
    throw new WledBleProtocolError('invalid-request');
  if (payload.op === 'setState') {
    validateLightingState(payload.state, ledCount);
    return payload as WledBleRequest;
  }
  if ((payload.op !== 'getInfo' && payload.op !== 'getState') || Object.hasOwn(payload, 'state'))
    throw new WledBleProtocolError('invalid-request');
  return payload as WledBleRequest;
}

export function parseResponse(payload: unknown, expectedId: string): unknown {
  if (
    !isRecord(payload) ||
    !/^[A-Za-z0-9._:-]{1,64}$/.test(expectedId) ||
    payload.id !== expectedId ||
    Object.keys(payload).some((key) => !['id', 'result', 'error'].includes(key)) ||
    Object.hasOwn(payload, 'result') === Object.hasOwn(payload, 'error')
  )
    throw new WledBleProtocolError('invalid-response');
  if (Object.hasOwn(payload, 'error')) {
    if (!isRecord(payload.error) || !nonempty(payload.error.code)) throw new WledBleProtocolError('invalid-response');
    throw new WledBleProtocolError(payload.error.code);
  }
  return payload.result;
}

import { validateLightingState } from './lighting-state';
export { validateLightingState };
