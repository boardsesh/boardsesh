import { describe, expect, it } from 'vitest';
import { isSprayLedControllerName, parseAnyBoardTypeFromDeviceName } from '../advertised-identity';
import { parseBoardTypeFromDeviceName, parseSerialNumber } from '../aurora';
import { getMoonboardBluetoothPacket } from '../moonboard';

describe('advertised board identity', () => {
  it.each([
    ['Kilter Board#99000001@3', 'kilter'],
    ['Tension Board#99000002@3', 'tension'],
    ['MoonBoard A#99000003', 'moonboard'],
    ['MoonBoard A', 'moonboard'],
    ['Woods Board 12x12', 'woods'],
    ['Unrelated accessory', undefined],
    [undefined, undefined],
  ])('recognizes %s independently of the encoder', (name, boardType) => {
    expect(parseAnyBoardTypeFromDeviceName(name)).toBe(boardType);
  });

  it('keeps a MoonBoard fixture on its ASCII transport', () => {
    expect(parseSerialNumber('MoonBoard A#99000003')).toBe('99000003');
    expect(parseBoardTypeFromDeviceName('MoonBoard A#99000003')).toBeUndefined();
    const { packet } = getMoonboardBluetoothPacket('p1r12', 18);
    expect(String.fromCharCode(...packet)).toMatch(/^l#/);
  });
});

describe('Spraywall LED controller identity', () => {
  it('recognizes the usermod name and nothing a board advertises', () => {
    expect(isSprayLedControllerName('Boardsesh Spraywall 1A2B')).toBe(true);
    expect(isSprayLedControllerName('Kilter Board#751737@3')).toBe(false);
    expect(isSprayLedControllerName('MoonBoard A')).toBe(false);
    expect(isSprayLedControllerName(undefined)).toBe(false);
  });

  it('is never read as a board type', () => {
    expect(parseAnyBoardTypeFromDeviceName('Boardsesh Spraywall 1A2B')).toBeUndefined();
    expect(parseSerialNumber('Boardsesh Spraywall 1A2B')).toBeUndefined();
  });
});
