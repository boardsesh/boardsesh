import { describe, expect, it } from 'vitest';
import { AURORA_ADVERTISED_SERVICE_UUID, UART_SERVICE_UUID } from '@boardsesh/ble-protocol';
import { boardFamily, isLikelyBoardDevice } from './device-filter';

describe('isLikelyBoardDevice', () => {
  it('matches MoonBoard controllers by name or UART service', () => {
    expect(isLikelyBoardDevice({ name: 'MoonBoard A', serviceUuids: [], family: 'moonboard' })).toBe(true);
    expect(isLikelyBoardDevice({ name: null, serviceUuids: [UART_SERVICE_UUID], family: 'moonboard' })).toBe(true);
  });

  it('matches Aurora controllers by service or by a board name', () => {
    expect(isLikelyBoardDevice({ name: null, serviceUuids: [AURORA_ADVERTISED_SERVICE_UUID], family: 'aurora' })).toBe(
      true,
    );
    expect(isLikelyBoardDevice({ name: 'Tension Board#12345@3', serviceUuids: [], family: 'aurora' })).toBe(true);
    expect(isLikelyBoardDevice({ name: 'Kilter Board', serviceUuids: [], family: 'aurora' })).toBe(true);
  });

  it('ignores other Bluetooth devices', () => {
    expect(isLikelyBoardDevice({ name: 'JBL Flip 6', serviceUuids: [], family: 'moonboard' })).toBe(false);
    expect(isLikelyBoardDevice({ name: 'JBL Flip 6', serviceUuids: [], family: 'aurora' })).toBe(false);
    expect(isLikelyBoardDevice({ name: null, serviceUuids: [], family: 'aurora' })).toBe(false);
  });

  it('matches Woods controllers by name or UART service', () => {
    expect(isLikelyBoardDevice({ name: 'Woods Board 12x12', serviceUuids: [], family: 'woods' })).toBe(true);
    expect(isLikelyBoardDevice({ name: null, serviceUuids: [UART_SERVICE_UUID], family: 'woods' })).toBe(true);
  });

  it('keeps each board family to its own controllers', () => {
    expect(isLikelyBoardDevice({ name: 'MoonBoard A', serviceUuids: [], family: 'aurora' })).toBe(false);
    expect(isLikelyBoardDevice({ name: 'Tension Board#1@3', serviceUuids: [], family: 'moonboard' })).toBe(false);
    expect(isLikelyBoardDevice({ name: 'MoonBoard A', serviceUuids: [], family: 'woods' })).toBe(false);
    expect(isLikelyBoardDevice({ name: 'Woods Board', serviceUuids: [], family: 'aurora' })).toBe(false);
  });
});

describe('boardFamily', () => {
  it('gives MoonBoard and Woods their own families and the rest to Aurora', () => {
    expect(boardFamily('moonboard')).toBe('moonboard');
    expect(boardFamily('woods')).toBe('woods');
    for (const boardName of ['tension', 'kilter', 'decoy', 'touchstone', 'grasshopper', 'soill'] as const) {
      expect(boardFamily(boardName)).toBe('aurora');
    }
  });
});
