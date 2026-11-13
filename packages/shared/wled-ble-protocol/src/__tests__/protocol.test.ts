import { describe, expect, it } from 'vitest';
import vectorsJson from '../../test-vectors.json?raw';
import {
  WledBleFrameAssembler,
  decodeUtf8,
  encodeFrame,
  encodeUtf8,
  fragmentFrame,
  parseCapabilities,
  parseRequest,
  parseResponse,
  validateLightingState,
} from '../index';

const capabilities = {
  controllerId: 'wled-aabbccddeeff',
  protocolVersion: 1,
  name: 'Gym 🧗',
  wledVersion: '16.0.1',
  ledCount: 1000,
  audio: true,
  maxMessageBytes: 8192,
};

describe('WLED BLE framing', () => {
  it('matches the shared C++/TypeScript frame vectors exactly', () => {
    const vectors = JSON.parse(vectorsJson) as {
      vectors: { name: string; message: unknown; frameHex: string }[];
    };
    for (const vector of vectors.vectors) {
      const frame = encodeFrame(vector.message);
      expect(Array.from(frame, (byte) => byte.toString(16).padStart(2, '0')).join(''), vector.name).toBe(
        vector.frameHex,
      );
      expect(new WledBleFrameAssembler().push(frame)).toEqual(vector.message);
    }
  });
  it.each([1, 2, 3, 4, 20, 182, 512])('round-trips multibyte JSON using %i-byte fragments', (payloadBytes) => {
    const message = { id: 'first', result: capabilities };
    const assembler = new WledBleFrameAssembler();
    const fragments = fragmentFrame(encodeFrame(message), payloadBytes);
    for (const fragment of fragments.slice(0, -1)) expect(assembler.push(fragment, 100)).toBeNull();
    expect(assembler.push(fragments.at(-1)!, 101)).toEqual(message);
  });
  it('uses byte lengths and little-endian headers', () => {
    const frame = encodeFrame({ id: 'é' });
    expect(Array.from(frame.subarray(0, 4))).toEqual([11, 0, 0, 0]);
    expect(frame.length).toBe(15);
  });
  it('does not infer completion from short packets', () => {
    const frame = encodeFrame({ id: 'x', result: 'a'.repeat(100) });
    const assembler = new WledBleFrameAssembler();
    expect(assembler.push(frame.slice(0, 9))).toBeNull();
    expect(assembler.push(frame.slice(9))).toEqual({ id: 'x', result: 'a'.repeat(100) });
  });
  it.each([{ bytes: [0, 0, 0, 0] }, { bytes: [1, 32, 0, 0] }, { bytes: [255, 255, 255, 255] }])(
    'rejects malformed lengths %j',
    ({ bytes }) => {
      expect(() => new WledBleFrameAssembler().push(Uint8Array.from(bytes))).toThrow('invalid-length');
    },
  );
  it('rejects oversized encoding and receiving before allocating from an attacker length', () => {
    expect(() => encodeFrame({ result: 'a'.repeat(8192) })).toThrow('message-too-large');
    expect(() => new WledBleFrameAssembler().push(new Uint8Array(8197))).toThrow('message-too-large');
  });
  it('accepts exactly the advertised message limit', () => {
    const message = { padding: 'a'.repeat(8178) };
    const frame = encodeFrame(message);
    expect(frame.length).toBe(8196);
    expect(new WledBleFrameAssembler().push(frame)).toEqual(message);
  });
  it('rejects malformed JSON, invalid UTF8, non-objects and coalesced messages', () => {
    for (const bytes of [
      [1, 0, 0, 0, 123],
      [1, 0, 0, 0, 255],
      [4, 0, 0, 0, 110, 117, 108, 108],
    ]) {
      expect(() => new WledBleFrameAssembler().push(Uint8Array.from(bytes))).toThrow();
    }
    const frame = encodeFrame({ id: 'x' });
    expect(() => new WledBleFrameAssembler().push(Uint8Array.from([...frame, 0]))).toThrow('trailing-bytes');
  });
  it('expires incomplete messages after five seconds of fragment inactivity and starts cleanly', () => {
    const assembler = new WledBleFrameAssembler();
    const frame = encodeFrame({ id: 'x' });
    assembler.push(frame.slice(0, 3), 100);
    expect(() => assembler.push(frame.slice(3), 5100)).toThrow('fragment-timeout');
    expect(assembler.push(frame, 5101)).toEqual({ id: 'x' });
  });
  it('discards fragments on disconnect without replay on a new connection', () => {
    const assembler = new WledBleFrameAssembler();
    assembler.push(encodeFrame({ id: 'old' }).slice(0, 7));
    assembler.reset();
    expect(assembler.push(encodeFrame({ id: 'new' }))).toEqual({ id: 'new' });
  });
  it('rejects overlong, truncated and surrogate UTF8 sequences', () => {
    for (const sequence of [[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0]]) {
      expect(() => decodeUtf8(Uint8Array.from(sequence))).toThrow('invalid-utf8');
    }
    expect(decodeUtf8(encodeUtf8('é 🧗'))).toBe('é 🧗');
  });
});

describe('WLED BLE message validation', () => {
  it('accepts capabilities and refuses incompatible versions, identity and message limits', () => {
    expect(parseCapabilities(capabilities)).toEqual(capabilities);
    for (const invalid of [
      { protocolVersion: 2 },
      { maxMessageBytes: 8193 },
      { controllerId: 'phone-id' },
      { ledCount: 0 },
      { audio: 'true' },
    ]) {
      expect(() => parseCapabilities({ ...capabilities, ...invalid })).toThrow('invalid-capabilities');
    }
  });
  it('requires one operation, one ID and a lighting state only for writes', () => {
    expect(parseRequest({ id: 'x', op: 'getState' }, 1000)).toEqual({ id: 'x', op: 'getState' });
    for (const invalid of [
      { id: 'x', op: 'getState', state: {} },
      { id: '', op: 'getInfo' },
      { id: 'x', op: 'reboot' },
      { id: 'x', op: 'setState' },
      { id: 'x', op: 'setState', state: { on: true }, extra: 1 },
    ]) {
      expect(() => parseRequest(invalid, 1000)).toThrow();
    }
  });
  it('requires matching response IDs and distinguishes explicit application errors', () => {
    expect(parseResponse({ id: 'x', result: { success: true } }, 'x')).toEqual({ success: true });
    expect(() => parseResponse({ id: 'old', result: {} }, 'x')).toThrow('invalid-response');
    expect(() => parseResponse({ id: 'x', error: { code: 'busy' } }, 'x')).toThrow('busy');
    expect(() => parseResponse({ id: 'x', error: { code: 'busy' }, result: {} }, 'x')).toThrow('invalid-response');
  });
  it('accepts the runtime fields needed for full wake, individual colors and nightlight rearming', () => {
    expect(() =>
      validateLightingState(
        {
          on: true,
          bri: 64,
          tt: 0,
          live: false,
          lor: 1,
          nl: { on: false },
          udpn: { nn: true },
          seg: [
            {
              id: 0,
              start: 0,
              stop: 1000,
              on: true,
              bri: 255,
              fx: 0,
              pal: 0,
              grp: 1,
              spc: 0,
              of: 0,
              rev: false,
              mi: false,
              frz: false,
              col: [[0, 0, 0, 0]],
              i: [0, 1000, '00000000', 999, 'ff00ff00'],
            },
          ],
        },
        1000,
      ),
    ).not.toThrow();
  });
  it.each([
    {},
    { psave: 1 },
    { reboot: true },
    { cfg: {} },
    { um: {} },
    { on: 't' },
    { bri: 256 },
    { nl: { on: false, dur: 10 } },
    { udpn: { nn: true, send: true } },
    { live: true },
    { lor: 2 },
    { seg: [{ id: 0, n: 'persistent name' }] },
    { seg: [{ id: 0, stop: 1001 }] },
    { seg: [{ id: 0, i: [1000, 'FFFFFF'] }] },
    { seg: [{ id: 0, i: [0, 1001, 'FFFFFF'] }] },
    { seg: [{ id: 0, i: [0, 'FFFFFF', 1] }] },
    { seg: [{ id: 0, i: [0, 0, 'FFFFFF'] }] },
    { seg: [{ id: 0, i: [0, 'random'] }] },
  ])('rejects all disallowed state before applying: %j', (state) => {
    expect(() => validateLightingState(state, 1000)).toThrow('disallowed-state');
  });
});
