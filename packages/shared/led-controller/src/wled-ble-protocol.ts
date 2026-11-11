/**
 * The Boardsesh LED GATT protocol, version 1 (docs/spray-wall-led-ble.md).
 *
 * Pure encoding and decoding only: no Bluetooth library, no timers. The app's
 * driver (`wled-ble.ts`) and the WLED usermod
 * (firmware/wled-usermod-boardsesh-ble) speak exactly these bytes, and the
 * test vectors in the doc are asserted against this file.
 */

export const BLE_LED_PROTOCOL_VERSION = 1;

/** Advertised by every controller that speaks this protocol. */
export const BLE_LED_SERVICE_UUID = '7e100001-69ea-4190-8731-75eec7496aed';
/** Read, no encryption: who the controller is and what it accepts. */
export const BLE_LED_INFO_CHARACTERISTIC_UUID = '7e100002-69ea-4190-8731-75eec7496aed';
/** Write with response, encrypted and authenticated (bonded with the passkey). */
export const BLE_LED_CONTROL_CHARACTERISTIC_UUID = '7e100003-69ea-4190-8731-75eec7496aed';
/** Notify, encrypted and authenticated: one status frame per control frame. */
export const BLE_LED_STATUS_CHARACTERISTIC_UUID = '7e100004-69ea-4190-8731-75eec7496aed';

export const BLE_LED_OPCODES = {
  /** [brightness, autoOffMinutes]: the whole cable white, like Wi-Fi "Light all". */
  lightAll: 0x10,
  /** No payload: switch the strip off. */
  off: 0x11,
  /** [brightness]: wake, segment 0 over the whole cable, other segments off, all black, auto-off stopped. */
  previewBegin: 0x12,
  /** Runs of [start u16 LE, count u8, r, g, b]: set LED ranges in segment 0. */
  setPixels: 0x13,
  /** [minutes]: (re)start WLED's nightlight so the strip turns off by itself; 0 stops it. */
  autoOff: 0x14,
  /** [brightness]: switch on at this brightness and stop the auto-off timer. */
  wake: 0x15,
} as const;
export type BleLedOpcode = (typeof BLE_LED_OPCODES)[keyof typeof BLE_LED_OPCODES];

export const BLE_LED_STATUS = {
  ok: 0,
  unsupportedVersion: 1,
  malformed: 2,
  outOfRange: 3,
  busy: 4,
  unknownOpcode: 5,
} as const;

/** Version, opcode and sequence number start every control frame. */
export const BLE_LED_FRAME_HEADER_BYTES = 3;
export const BLE_LED_RUN_BYTES = 6;
/** ATT write header: a write can carry MTU − 3 bytes. */
export const ATT_WRITE_OVERHEAD = 3;
export const DEFAULT_ATT_MTU = 23;

export interface BleLedInfo {
  protocolVersion: number;
  /** The strip is on with a brightness above 0. */
  lit: boolean;
  ledCount: number;
  /** The largest control frame the controller buffers. */
  maxFrameBytes: number;
  name: string;
  version: string;
}

export interface BleLedStatus {
  protocolVersion: number;
  sequence: number;
  result: number;
}

/** One colour over consecutive LEDs. */
export interface BleLedRun {
  start: number;
  count: number;
  color: readonly [number, number, number];
}

export class BleLedProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleLedProtocolError';
  }
}

/** Hermes has no TextDecoder on every supported React Native version, so UTF-8 is done by hand. */
function utf8Encode(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return bytes;
}

function utf8Decode(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; ) {
    const lead = bytes[offset];
    const length = lead < 0x80 ? 1 : lead >= 0xc2 && lead < 0xe0 ? 2 : lead >= 0xe0 && lead < 0xf0 ? 3 : lead >= 0xf0 && lead < 0xf5 ? 4 : 0;
    if (!length || offset + length > bytes.length) throw new BleLedProtocolError('info is not UTF-8');
    let code = length === 1 ? lead : lead & (0xff >> (length + 1));
    for (let next = 1; next < length; next++) {
      const continuation = bytes[offset + next];
      if ((continuation & 0xc0) !== 0x80) throw new BleLedProtocolError('info is not UTF-8');
      code = (code << 6) | (continuation & 0x3f);
    }
    if ((length === 3 && (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))) || (length === 4 && (code < 0x10000 || code > 0x10ffff))) {
      throw new BleLedProtocolError('info is not UTF-8');
    }
    text += String.fromCodePoint(code);
    offset += length;
  }
  return text;
}

function readString(bytes: Uint8Array, offset: number): { value: string; next: number } {
  if (offset >= bytes.length) throw new BleLedProtocolError('info truncated');
  const length = bytes[offset];
  const end = offset + 1 + length;
  if (end > bytes.length) throw new BleLedProtocolError('info truncated');
  return { value: utf8Decode(bytes.subarray(offset + 1, end)), next: end };
}

/**
 * The info characteristic: [version][flags][ledCount u16 LE][maxFrame u16 LE]
 * [nameLength][name][versionLength][version]. Bytes after the version string are
 * reserved for later protocol versions and ignored.
 */
export function decodeBleLedInfo(bytes: Uint8Array): BleLedInfo {
  if (bytes.length < 6) throw new BleLedProtocolError('info truncated');
  const protocolVersion = bytes[0];
  // A newer controller may lay the rest out differently: report the version only.
  if (protocolVersion !== BLE_LED_PROTOCOL_VERSION) {
    return { protocolVersion, lit: false, ledCount: 0, maxFrameBytes: 0, name: '', version: '' };
  }
  const name = readString(bytes, 6);
  const version = readString(bytes, name.next);
  return {
    protocolVersion,
    lit: (bytes[1] & 0x01) !== 0,
    ledCount: bytes[2] | (bytes[3] << 8),
    maxFrameBytes: bytes[4] | (bytes[5] << 8),
    name: name.value,
    version: version.value,
  };
}

export function encodeBleLedInfo(info: Omit<BleLedInfo, 'protocolVersion'>): Uint8Array {
  const name = utf8Encode(info.name);
  const version = utf8Encode(info.version);
  if (name.length > 255 || version.length > 255) throw new RangeError('info string too long');
  return Uint8Array.from([
    BLE_LED_PROTOCOL_VERSION,
    info.lit ? 1 : 0,
    info.ledCount & 0xff,
    (info.ledCount >> 8) & 0xff,
    info.maxFrameBytes & 0xff,
    (info.maxFrameBytes >> 8) & 0xff,
    name.length,
    ...name,
    version.length,
    ...version,
  ]);
}

/** [version][sequence][result][reserved]. */
export function decodeBleLedStatus(bytes: Uint8Array): BleLedStatus {
  if (bytes.length < 3) throw new BleLedProtocolError('status truncated');
  return { protocolVersion: bytes[0], sequence: bytes[1], result: bytes[2] };
}

export function encodeBleLedStatus(status: Omit<BleLedStatus, 'protocolVersion'>): Uint8Array {
  return Uint8Array.from([BLE_LED_PROTOCOL_VERSION, status.sequence & 0xff, status.result & 0xff, 0]);
}

function byte(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError(`${what} must be 0–255`);
  return value;
}

export function encodeBleLedFrame(opcode: BleLedOpcode, sequence: number, payload: readonly number[] = []) {
  return Uint8Array.from([BLE_LED_PROTOCOL_VERSION, opcode, byte(sequence, 'sequence'), ...payload]);
}

export function encodeLightAll(sequence: number, brightness: number, autoOffMinutes: number) {
  return encodeBleLedFrame(BLE_LED_OPCODES.lightAll, sequence, [
    byte(brightness, 'brightness'),
    byte(autoOffMinutes, 'autoOffMinutes'),
  ]);
}

export function encodeOff(sequence: number) {
  return encodeBleLedFrame(BLE_LED_OPCODES.off, sequence);
}

export function encodePreviewBegin(sequence: number, brightness: number) {
  return encodeBleLedFrame(BLE_LED_OPCODES.previewBegin, sequence, [byte(brightness, 'brightness')]);
}

export function encodeAutoOff(sequence: number, minutes: number) {
  return encodeBleLedFrame(BLE_LED_OPCODES.autoOff, sequence, [byte(minutes, 'minutes')]);
}

export function encodeWake(sequence: number, brightness: number) {
  return encodeBleLedFrame(BLE_LED_OPCODES.wake, sequence, [byte(brightness, 'brightness')]);
}

export function encodeSetPixels(sequence: number, runs: readonly BleLedRun[]) {
  const payload: number[] = [];
  for (const run of runs) {
    if (!Number.isInteger(run.start) || run.start < 0 || run.start > 0xffff) throw new RangeError('run start');
    payload.push(
      run.start & 0xff,
      run.start >> 8,
      byte(run.count, 'count'),
      byte(run.color[0], 'red'),
      byte(run.color[1], 'green'),
      byte(run.color[2], 'blue'),
    );
    if (run.count === 0) throw new RangeError('count must be at least 1');
  }
  return encodeBleLedFrame(BLE_LED_OPCODES.setPixels, sequence, payload);
}

/**
 * Coalesce per-LED colours into runs: consecutive indices with the same colour
 * share one 6-byte run (the two LEDs behind one hold are usually neighbours).
 */
export function toBleLedRuns(pixels: ReadonlyMap<number, readonly [number, number, number]>): BleLedRun[] {
  const runs: BleLedRun[] = [];
  for (const index of [...pixels.keys()].sort((left, right) => left - right)) {
    const color = pixels.get(index)!;
    const last = runs[runs.length - 1];
    if (
      last &&
      last.start + last.count === index &&
      last.count < 255 &&
      last.color[0] === color[0] &&
      last.color[1] === color[1] &&
      last.color[2] === color[2]
    ) {
      last.count++;
    } else {
      runs.push({ start: index, count: 1, color: [color[0], color[1], color[2]] });
    }
  }
  return runs;
}

/** How many runs fit in one write, given the ATT MTU and the controller's buffer. */
export function bleLedRunsPerFrame(attMtu: number, maxFrameBytes: number): number {
  const frameBytes = Math.min(Math.max(attMtu, DEFAULT_ATT_MTU) - ATT_WRITE_OVERHEAD, maxFrameBytes);
  return Math.floor((frameBytes - BLE_LED_FRAME_HEADER_BYTES) / BLE_LED_RUN_BYTES);
}

export function chunkBleLedRuns(runs: readonly BleLedRun[], runsPerFrame: number): BleLedRun[][] {
  if (!Number.isInteger(runsPerFrame) || runsPerFrame < 1) throw new RangeError('runsPerFrame');
  const chunks: BleLedRun[][] = [];
  for (let offset = 0; offset < runs.length; offset += runsPerFrame) {
    chunks.push(runs.slice(offset, offset + runsPerFrame));
  }
  return chunks;
}
