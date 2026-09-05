// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWoodsBluetoothPacket, isWoodsDeviceName, WoodsMultiFrameError } from '../woods';
import { WOODS_LED_MAPS } from '@boardsesh/board-constants/woods';
import { splitMessages, MAX_BLUETOOTH_MESSAGE_SIZE } from '../transport';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('isWoodsDeviceName', () => {
  it('matches "Woods Board"', () => {
    expect(isWoodsDeviceName('Woods Board')).toBe(true);
  });

  it('matches "Woods Board v2"', () => {
    expect(isWoodsDeviceName('Woods Board v2')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isWoodsDeviceName('woods board')).toBe(true);
    expect(isWoodsDeviceName('WOODS BOARD V2')).toBe(true);
  });

  it('rejects other boards and empty input', () => {
    expect(isWoodsDeviceName('Kilter Board#123@3')).toBe(false);
    expect(isWoodsDeviceName('MoonBoard A')).toBe(false);
    expect(isWoodsDeviceName('')).toBe(false);
    expect(isWoodsDeviceName(undefined)).toBe(false);
  });
});

describe('getWoodsBluetoothPacket', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('reproduces the spec worked example (12x12)', () => {
    // baseHoldLocation 0=Start(4)->LED 28, 5=Hand(2)->237, 7=Finish(3)->341.
    const { packet } = getWoodsBluetoothPacket('p0r4p5r2p7r3', '12x12');
    expect(decode(packet)).toBe('28,4,237,2,341,3,!');
  });

  it('encodes a single hold with its terminator', () => {
    const { packet } = getWoodsBluetoothPacket('p0r4', '12x12');
    expect(decode(packet)).toBe('28,4,!');
  });

  it('clears the board for empty frames (bare terminator)', () => {
    const result = getWoodsBluetoothPacket('', '12x12');
    expect(decode(result.packet)).toBe(',!');
    expect(result.totalPlacements).toBe(0);
  });

  it('rejects Aurora multi-frame separators before encoding a partial command', () => {
    expect(() => getWoodsBluetoothPacket('p0r4,p5r2', '12x12')).toThrow(WoodsMultiFrameError);
  });

  it('maps every Woods role code (Foot/Hand/Finish/Start)', () => {
    // 8x10: loc 0->LED 24. Use four holds with each role code.
    const m = WOODS_LED_MAPS['8x10'];
    const { packet } = getWoodsBluetoothPacket('p0r1p1r2p2r3p3r4', '8x10');
    expect(decode(packet)).toBe(`${m[0]},1,${m[1]},2,${m[2]},3,${m[3]},4,!`);
  });

  it('uses a different LED table per board size for the same hold', () => {
    // baseHoldLocation 1 -> LED 29 on 12x12 but 25 on 8x10.
    expect(decode(getWoodsBluetoothPacket('p1r2', '12x12').packet)).toBe('29,2,!');
    expect(decode(getWoodsBluetoothPacket('p1r2', '8x10').packet)).toBe('25,2,!');
  });

  it('skips holds whose role code is not a lit Woods role', () => {
    const result = getWoodsBluetoothPacket('p0r4p1r9', '12x12');
    expect(decode(result.packet)).toBe('28,4,!');
    expect(result.skippedRoleCount).toBe(1);
    expect(result.totalPlacements).toBe(2);
  });

  it('skips holds with no LED for the board size and counts them', () => {
    // baseHoldLocation 999 has no entry in either table.
    const result = getWoodsBluetoothPacket('p0r4p999r2', '12x12');
    expect(decode(result.packet)).toBe('28,4,!');
    expect(result.skippedPositionCount).toBe(1);
    expect(result.totalPlacements).toBe(2);
    // The encoder is library code: it reports skips through the return value and
    // never logs. The mobile caller turns the counts into a Sentry breadcrumb.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('chunks a long command into 20-byte writes that reassemble to the message', () => {
    // Light every hold on the 8x10 board as a hand hold -> a long ASCII command.
    const frames = Object.keys(WOODS_LED_MAPS['8x10'])
      .map((loc) => `p${loc}r2`)
      .join('');
    const { packet } = getWoodsBluetoothPacket(frames, '8x10');
    expect(packet.length).toBeGreaterThan(MAX_BLUETOOTH_MESSAGE_SIZE);

    const chunks = splitMessages(packet);
    expect(chunks.length).toBe(Math.ceil(packet.length / MAX_BLUETOOTH_MESSAGE_SIZE));

    const reassembled = new Uint8Array(packet.length);
    let offset = 0;
    for (const chunk of chunks) {
      reassembled.set(chunk, offset);
      offset += chunk.length;
    }
    expect(decode(reassembled)).toBe(decode(packet));
    // The reassembled command still ends with the Woods terminator.
    expect(decode(reassembled).endsWith(',!')).toBe(true);
  });
});

describe('WOODS_LED_MAPS integrity', () => {
  it('has the expected entry counts and key/LED ranges (spec §7)', () => {
    const small = WOODS_LED_MAPS['8x10'];
    const large = WOODS_LED_MAPS['12x12'];

    const smallKeys = Object.keys(small).map(Number);
    const largeKeys = Object.keys(large).map(Number);

    expect(smallKeys.length).toBe(485);
    expect(largeKeys.length).toBe(894);

    expect(Math.min(...smallKeys)).toBe(0);
    expect(Math.max(...smallKeys)).toBe(484);
    expect(Math.min(...largeKeys)).toBe(0);
    expect(Math.max(...largeKeys)).toBe(893);

    expect(Math.max(...Object.values(small))).toBe(484);
    expect(Math.max(...Object.values(large))).toBe(897);
  });
});
