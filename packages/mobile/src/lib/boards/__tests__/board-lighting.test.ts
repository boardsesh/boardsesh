import { describe, expect, it } from 'vitest';
import { boardHasLights, drivesWithoutBluetooth, litByWallDevice } from '../board-lighting';

describe('drivesWithoutBluetooth', () => {
  it('connects over Bluetooth to an LED board with no wall device', () => {
    expect(drivesWithoutBluetooth({ boardType: 'kilter', hasLeds: true, litByWallDevice: false })).toBe(false);
  });

  it('takes the wall on a board with no light kit', () => {
    expect(drivesWithoutBluetooth({ boardType: 'kilter', hasLeds: false })).toBe(true);
  });

  it('takes the wall on an LED board lit by a wall device', () => {
    expect(drivesWithoutBluetooth({ boardType: 'tension', hasLeds: true, litByWallDevice: true })).toBe(true);
  });

  it('takes the wall on a spray wall, with or without a wall device', () => {
    expect(drivesWithoutBluetooth({ boardType: 'spray', hasLeds: false })).toBe(true);
    expect(drivesWithoutBluetooth({ boardType: 'spray', hasLeds: false, litByWallDevice: true })).toBe(true);
  });

  it('keeps Bluetooth when the fields are missing, so a stale snapshot never strands an LED wall', () => {
    expect(drivesWithoutBluetooth({ boardType: 'kilter' })).toBe(false);
    expect(drivesWithoutBluetooth({ boardType: 'kilter', hasLeds: null, litByWallDevice: null })).toBe(false);
    expect(drivesWithoutBluetooth(null)).toBe(false);
    expect(drivesWithoutBluetooth(undefined)).toBe(false);
  });
});

describe('boardHasLights', () => {
  it('reads an LED board as lit', () => {
    expect(boardHasLights({ boardType: 'moonboard', hasLeds: true })).toBe(true);
    expect(boardHasLights({ boardType: 'moonboard' })).toBe(true);
  });

  it('reads a board with no light kit as dark', () => {
    expect(boardHasLights({ boardType: 'kilter', hasLeds: false })).toBe(false);
  });

  it('reads a spray wall as dark until a wall device lights it', () => {
    expect(boardHasLights({ boardType: 'spray', hasLeds: false })).toBe(false);
    expect(boardHasLights({ boardType: 'spray', hasLeds: false, litByWallDevice: true })).toBe(true);
  });

  it('reads an LED board lit by a wall device as lit', () => {
    expect(boardHasLights({ boardType: 'kilter', hasLeds: true, litByWallDevice: true })).toBe(true);
  });

  it('defaults to lit with no board, matching the optional-field contract', () => {
    expect(boardHasLights(null)).toBe(true);
  });
});

describe('litByWallDevice', () => {
  it('is true only for an explicit true', () => {
    expect(litByWallDevice({ litByWallDevice: true })).toBe(true);
    expect(litByWallDevice({ litByWallDevice: false })).toBe(false);
    expect(litByWallDevice({})).toBe(false);
    expect(litByWallDevice(null)).toBe(false);
  });
});
