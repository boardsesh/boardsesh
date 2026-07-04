import { describe, it, expect } from 'vitest';
import { AURORA_ADVERTISED_SERVICE_UUID, UART_SERVICE_UUID, REDBEARLAB_SERVICE_UUID } from '@boardsesh/ble-protocol';
import { isLikelyBoardDevice } from '../board-device-filter';

describe('isLikelyBoardDevice', () => {
  it('accepts a device advertising the Aurora service UUID regardless of name', () => {
    expect(
      isLikelyBoardDevice({
        name: undefined,
        serviceUuids: [AURORA_ADVERTISED_SERVICE_UUID],
        scanFamily: 'aurora',
      }),
    ).toBe(true);
  });

  it('does not accept generic UART devices on Aurora scans', () => {
    expect(
      isLikelyBoardDevice({
        name: 'whatever',
        serviceUuids: [UART_SERVICE_UUID.toUpperCase()],
        scanFamily: 'aurora',
      }),
    ).toBe(false);
  });

  it('accepts UART devices on MoonBoard scans', () => {
    expect(
      isLikelyBoardDevice({
        name: 'MoonBoard',
        serviceUuids: [UART_SERVICE_UUID.toUpperCase()],
        scanFamily: 'moonboard',
      }),
    ).toBe(true);
  });

  it('accepts an original RedBearLab box on MoonBoard scans regardless of name', () => {
    // First-generation MoonBoard LED boxes (RedBearLab controller, #3299): if
    // the box advertises its service UUID, don't depend on the name prefix.
    expect(
      isLikelyBoardDevice({
        name: undefined,
        serviceUuids: [REDBEARLAB_SERVICE_UUID.toUpperCase()],
        scanFamily: 'moonboard',
      }),
    ).toBe(true);
  });

  it('does not accept RedBearLab devices on Aurora scans', () => {
    expect(
      isLikelyBoardDevice({
        name: 'whatever',
        serviceUuids: [REDBEARLAB_SERVICE_UUID],
        scanFamily: 'aurora',
      }),
    ).toBe(false);
  });

  it('accepts a MoonBoard by name even when no service UUIDs are advertised', () => {
    // The whole reason the scan runs unfiltered: MoonBoard controllers don't
    // reliably include the UART UUID in their advertisements.
    expect(isLikelyBoardDevice({ name: 'MoonBoard A1B2', serviceUuids: [], scanFamily: 'moonboard' })).toBe(true);
    expect(isLikelyBoardDevice({ name: 'Moonboard Mini', serviceUuids: null, scanFamily: 'moonboard' })).toBe(true);
  });

  it('accepts Aurora boards by product name when the advertisement lacks UUIDs', () => {
    expect(isLikelyBoardDevice({ name: 'Kilter Board#751737@3', serviceUuids: [], scanFamily: 'aurora' })).toBe(true);
    expect(isLikelyBoardDevice({ name: 'Tension Board#42@2', scanFamily: 'aurora' })).toBe(true);
  });

  it('accepts a renamed Aurora board only when it keeps the #serial@api suffix', () => {
    expect(isLikelyBoardDevice({ name: 'Garage Wall#900001@3', serviceUuids: [], scanFamily: 'aurora' })).toBe(true);
    expect(isLikelyBoardDevice({ name: 'Garage Wall#900001', serviceUuids: [], scanFamily: 'aurora' })).toBe(false);
  });

  it('trusts old-iOS-binary Aurora scans that omit serviceUuids entirely', () => {
    // Old iOS binaries scan-filter natively by the Aurora service UUID and report
    // `serviceUuids` as undefined, so a renamed board with no #serial@api suffix
    // still surfaces. An empty array or `null` is not vouched for.
    expect(isLikelyBoardDevice({ name: 'Garage Wall', serviceUuids: undefined, scanFamily: 'aurora' })).toBe(true);
    expect(isLikelyBoardDevice({ name: 'Garage Wall', serviceUuids: [], scanFamily: 'aurora' })).toBe(false);
    expect(isLikelyBoardDevice({ name: 'Garage Wall', serviceUuids: null, scanFamily: 'aurora' })).toBe(false);
  });

  it('falls back to name matching when a moonboard scan omits serviceUuids entirely', () => {
    // Unlike the Aurora branch, `undefined` is not vouched for on moonboard
    // scans (old iOS binaries filtered those natively on [UART, RedBearLab],
    // but the name check still applies).
    expect(isLikelyBoardDevice({ name: 'MoonBoard A1B2', serviceUuids: undefined, scanFamily: 'moonboard' })).toBe(
      true,
    );
    expect(isLikelyBoardDevice({ name: 'Garage Wall', serviceUuids: undefined, scanFamily: 'moonboard' })).toBe(false);
    expect(isLikelyBoardDevice({ name: undefined, serviceUuids: undefined, scanFamily: 'moonboard' })).toBe(false);
  });

  it('rejects unrelated devices', () => {
    expect(isLikelyBoardDevice({ name: 'JBL Flip 6', serviceUuids: [], scanFamily: 'moonboard' })).toBe(false);
    expect(isLikelyBoardDevice({ name: undefined, serviceUuids: [], scanFamily: 'aurora' })).toBe(false);
    expect(
      isLikelyBoardDevice({
        name: 'Fitbit Charge',
        serviceUuids: ['0000180d-0000-1000-8000-00805f9b34fb'],
        scanFamily: 'aurora',
      }),
    ).toBe(false);
    expect(isLikelyBoardDevice({ name: "Marco's AirPods #1", serviceUuids: [], scanFamily: 'aurora' })).toBe(false);
  });
});
