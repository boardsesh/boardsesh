import { describe, it, expect } from 'vitest';
import {
  splitMessages,
  MAX_BLUETOOTH_MESSAGE_SIZE,
  AURORA_ADVERTISED_SERVICE_UUID,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  REDBEARLAB_SERVICE_UUID,
  REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
} from '../transport';

describe('BLE service/characteristic UUID constants', () => {
  // These are the spec UUIDs (lowercased); changing one silently breaks
  // scanning/discovery on every platform, so pin them exactly.
  it('matches the documented Aurora + Nordic UART UUIDs', () => {
    expect(AURORA_ADVERTISED_SERVICE_UUID).toBe('4488b571-7806-4df6-bcff-a2897e4953ff');
    expect(UART_SERVICE_UUID).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
    expect(UART_WRITE_CHARACTERISTIC_UUID).toBe('6e400002-b5a3-f393-e0a9-e50e24dcca9e');
  });

  it('matches the documented original-MoonBoard (RedBearLab) UUIDs', () => {
    // docs/MOONBOARD_BLUETOOTH_PROTOCOL_SPEC.md §2.1.
    expect(REDBEARLAB_SERVICE_UUID).toBe('713d0000-503e-4c75-ba94-3148f18d941e');
    expect(REDBEARLAB_WRITE_CHARACTERISTIC_UUID).toBe('713d0003-503e-4c75-ba94-3148f18d941e');
  });
});

describe('splitMessages', () => {
  it('splits a buffer larger than 20 bytes into chunks', () => {
    const buffer = new Uint8Array(50);
    for (let byteIndex = 0; byteIndex < 50; byteIndex++) buffer[byteIndex] = byteIndex;

    const chunks = splitMessages(buffer);
    expect(chunks).toHaveLength(3); // ceil(50/20) = 3
    expect(chunks[0].length).toBe(MAX_BLUETOOTH_MESSAGE_SIZE);
    expect(chunks[1].length).toBe(MAX_BLUETOOTH_MESSAGE_SIZE);
    expect(chunks[2].length).toBe(10); // remaining
  });

  it('returns a single chunk for data smaller than 20 bytes', () => {
    const buffer = new Uint8Array(10);
    const chunks = splitMessages(buffer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(10);
  });

  it('returns a single chunk for exactly 20 bytes', () => {
    const buffer = new Uint8Array(MAX_BLUETOOTH_MESSAGE_SIZE);
    const chunks = splitMessages(buffer);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(MAX_BLUETOOTH_MESSAGE_SIZE);
  });

  it('returns an empty array for empty buffer', () => {
    const buffer = new Uint8Array(0);
    const chunks = splitMessages(buffer);
    expect(chunks).toHaveLength(0);
  });

  it('preserves data content across chunks', () => {
    const buffer = new Uint8Array(25);
    for (let byteIndex = 0; byteIndex < 25; byteIndex++) buffer[byteIndex] = byteIndex;

    const chunks = splitMessages(buffer);
    const reassembled = new Uint8Array(25);
    let offset = 0;
    for (const chunk of chunks) {
      reassembled.set(chunk, offset);
      offset += chunk.length;
    }
    expect(reassembled).toEqual(buffer);
  });
});
