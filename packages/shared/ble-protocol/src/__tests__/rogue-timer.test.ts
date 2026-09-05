// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import {
  RogueTimerCommand,
  buildRogueTimerFrame,
  rogueTimerNumpadCode,
  isRogueEchoDeviceName,
  detectRogueDeviceType,
  ROGUE_TIMER_SERVICE_UUID,
  ROGUE_TIMER_CHARACTERISTIC_UUID,
} from '../rogue-timer';

// The base64 the app writes to `ffe1` for a given press. ble-plx and Web
// Bluetooth both take base64, so these are the exact bytes on the wire. Encoded
// inline (no Buffer) to keep this pure package's tests platform-agnostic.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const hasByte1 = offset + 1 < bytes.length;
    const hasByte2 = offset + 2 < bytes.length;
    const byte0 = bytes[offset];
    const byte1 = hasByte1 ? bytes[offset + 1] : 0;
    const byte2 = hasByte2 ? bytes[offset + 2] : 0;
    out += B64_ALPHABET[byte0 >> 2];
    out += B64_ALPHABET[((byte0 & 0b11) << 4) | (byte1 >> 4)];
    out += hasByte1 ? B64_ALPHABET[((byte1 & 0b1111) << 2) | (byte2 >> 6)] : '=';
    out += hasByte2 ? B64_ALPHABET[byte2 & 0b111111] : '=';
  }
  return out;
}

describe('rogue-timer protocol', () => {
  it('builds the fixed 4-byte frame `55 AA 01 <code>`', () => {
    expect(Array.from(buildRogueTimerFrame(RogueTimerCommand.POWER))).toEqual([0x55, 0xaa, 0x01, 0x00]);
    expect(Array.from(buildRogueTimerFrame(RogueTimerCommand.STOPWATCH))).toEqual([0x55, 0xaa, 0x01, 0x04]);
  });

  // Byte-exact fixtures straight from ROGUE_TIMER_BLE_SPEC.md §5 "Raw examples".
  it('matches the spec base64 fixtures', () => {
    expect(toBase64(buildRogueTimerFrame(RogueTimerCommand.POWER))).toBe('VaoBAA==');
    expect(toBase64(buildRogueTimerFrame(RogueTimerCommand.OK))).toBe('VaoBDA==');
    expect(toBase64(buildRogueTimerFrame(RogueTimerCommand.RESET))).toBe('VaoBCg==');
    expect(toBase64(buildRogueTimerFrame(RogueTimerCommand.EMOM))).toBe('VaoBIQ==');
  });

  it('maps numpad digits to BTN0..BTN9 (spec §6)', () => {
    expect(rogueTimerNumpadCode(0)).toBe(RogueTimerCommand.BTN0);
    expect(rogueTimerNumpadCode(9)).toBe(RogueTimerCommand.BTN9);
    expect(rogueTimerNumpadCode(5)).toBe(0x18);
    expect(() => rogueTimerNumpadCode(10)).toThrow(RangeError);
    expect(() => rogueTimerNumpadCode(-1)).toThrow(RangeError);
  });

  it('exposes the timer GATT UUIDs from spec §2', () => {
    expect(ROGUE_TIMER_SERVICE_UUID).toBe('0000ffe0-0000-1000-8000-00805f9b34fb');
    expect(ROGUE_TIMER_CHARACTERISTIC_UUID).toBe('0000ffe1-0000-1000-8000-00805f9b34fb');
  });

  it('matches Rogue/Echo device names case-insensitively (spec §3)', () => {
    expect(isRogueEchoDeviceName('Rogue Home Timer')).toBe(true);
    expect(isRogueEchoDeviceName('Rogue Echo Gym Timer')).toBe(true);
    expect(isRogueEchoDeviceName('ECHO_ROWER')).toBe(true);
    expect(isRogueEchoDeviceName('Kilter Board A1B2')).toBe(false);
    expect(isRogueEchoDeviceName(null)).toBe(false);
    expect(isRogueEchoDeviceName(undefined)).toBe(false);
  });

  it('classifies the Rogue device family from the name (spec §3)', () => {
    expect(detectRogueDeviceType('Rogue Home Timer')).toBe('timer');
    expect(detectRogueDeviceType('Rogue Echo Gym Timer')).toBe('timer');
    expect(detectRogueDeviceType('Echo_Rower')).toBe('rower');
    expect(detectRogueDeviceType('Echo Bike V3')).toBe('bike');
    expect(detectRogueDeviceType('Echo Skier')).toBe('skier');
    expect(detectRogueDeviceType('Rogue Whatever')).toBe('unknown');
    expect(detectRogueDeviceType(undefined)).toBe('unknown');
  });
});
