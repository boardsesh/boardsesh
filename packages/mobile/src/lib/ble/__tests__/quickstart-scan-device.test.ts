// What the Bluetooth quickstart keeps from an advertisement. Runs against the
// real name parsers and board filter, because the point is which real-world
// names get in.
import { describe, expect, it } from 'vitest';
import { AURORA_ADVERTISED_SERVICE_UUID, REDBEARLAB_SERVICE_UUID, UART_SERVICE_UUID } from '@boardsesh/ble-protocol';
import { classifyQuickstartDevice, compareBySignal } from '../quickstart-scan-device';

function heard(name: string | undefined, serviceUuids: string[] = [], rssi: number | null = -60) {
  return classifyQuickstartDevice({ deviceId: `id-${name ?? 'nameless'}`, name, serviceUuids, rssi });
}

describe('classifyQuickstartDevice', () => {
  it('keeps an Aurora box with a serial, with the type its name announces', () => {
    expect(heard('Kilter Board#751737@3', [AURORA_ADVERTISED_SERVICE_UUID], -48)).toEqual({
      key: 'serial:751737',
      deviceId: 'id-Kilter Board#751737@3',
      name: 'Kilter Board#751737@3',
      kind: 'serial',
      serial: '751737',
      boardType: 'kilter',
      rssi: -48,
    });
  });

  it('resolves a serial-bearing MoonBoard fixture alongside Aurora controllers', () => {
    expect(heard('MoonBoard A#99000003', [UART_SERVICE_UUID])).toMatchObject({
      key: 'serial:99000003',
      kind: 'serial',
      boardType: 'moonboard',
      serial: '99000003',
    });
  });

  // Ordinary MoonBoards advertise no serial, so keep their peripheral identity.
  it.each(['MoonBoard A', 'Moonboard', 'MoonBoard'])('keeps a MoonBoard named "%s", keyed by its device', (name) => {
    expect(heard(name)).toMatchObject({
      key: `device:id-${name}`,
      kind: 'moonboard',
      boardType: 'moonboard',
      serial: null,
    });
  });

  it('keeps a MoonBoard whatever service it advertises, or none', () => {
    expect(heard('MoonBoard A', [UART_SERVICE_UUID])?.kind).toBe('moonboard');
    expect(heard('MoonBoard A', [REDBEARLAB_SERVICE_UUID])?.kind).toBe('moonboard');
    expect(heard('MoonBoard A', [])?.kind).toBe('moonboard');
  });

  // Nordic UART is everywhere: heart-rate straps, LED strips, dev boards. Only
  // the name may say "MoonBoard".
  it.each([
    ['a UART gadget', 'Nordic_UART', [UART_SERVICE_UUID]],
    ['a RedBearLab gadget', 'BLE Shield', [REDBEARLAB_SERVICE_UUID]],
    ['a nameless UART device', undefined, [UART_SERVICE_UUID]],
    ['a Woods board, which shares the MoonBoard scan filter', 'Woods Board 12x12', [UART_SERVICE_UUID]],
    ['a name with "moonboard" further in', 'My MoonBoard Lights', [UART_SERVICE_UUID]],
  ])('drops %s', (_label, name, serviceUuids) => {
    expect(heard(name, serviceUuids)).toBeNull();
  });

  it('keeps a Kilter-built box that advertises a bare name, keyed by its device', () => {
    expect(heard('Kilter Board', [AURORA_ADVERTISED_SERVICE_UUID])).toMatchObject({
      key: 'device:id-Kilter Board',
      kind: 'bare_name',
      boardType: 'kilter',
      serial: null,
    });
  });

  // `isKilterBuiltBox` is a name rule over every Aurora type, so a bare Tension
  // box is kept as Tension, not called a Kilter.
  it('names a bare-name box by the type it announces', () => {
    expect(heard('Tension Board')).toMatchObject({ kind: 'bare_name', boardType: 'tension' });
  });

  it.each(['kilter board', 'KILTER BOARD', '  Kilter Board  ', 'Kilter Board@2', 'So iLL Board', 'Grasshopper Board'])(
    'keeps a bare name that is exactly "<Type> Board": %s',
    (name) => {
      expect(heard(name)?.kind).toBe('bare_name');
    },
  );

  // `isKilterBuiltBox` is a prefix match. These would have read "Found a board".
  it.each(['Tensioner', 'Kilter-anything', 'Kilter Board Pro', 'Kilterboard Speaker', 'Decoy', 'Tension'])(
    'drops a lookalike bare name: %s',
    (name) => {
      expect(heard(name)).toBeNull();
    },
  );

  it('keeps a bare "<Type>" only when the device advertises the Aurora service', () => {
    expect(heard('Decoy', [AURORA_ADVERTISED_SERVICE_UUID])).toMatchObject({ kind: 'bare_name', boardType: 'decoy' });
    expect(heard('Decoy', [UART_SERVICE_UUID])).toBeNull();
  });

  it('still drops peripherals whose "#serial" is not a board', () => {
    expect(heard('Printer #751737')).toBeNull();
    expect(heard("Marco's AirPods #1")).toBeNull();
  });

  it('drops an Aurora-service device with no name: there is no type to offer', () => {
    expect(heard(undefined, [AURORA_ADVERTISED_SERVICE_UUID])).toBeNull();
  });

  // CoreBluetooth's "no reading" value would otherwise sort first.
  it('reads RSSI 127 and a missing reading as no signal', () => {
    expect(heard('MoonBoard A', [], 127)?.rssi).toBeNull();
    expect(heard('MoonBoard A', [], null)?.rssi).toBeNull();
  });
});

describe('compareBySignal', () => {
  it('puts the strongest signal first, unknown last, and keeps ties in the order heard', () => {
    const boards = [
      { label: 'far', rssi: -90 },
      { label: 'unknown', rssi: null },
      { label: 'near', rssi: -40 },
      { label: 'mid-first', rssi: -65 },
      { label: 'mid-second', rssi: -65 },
    ];
    expect([...boards].sort(compareBySignal).map((board) => board.label)).toEqual([
      'near',
      'mid-first',
      'mid-second',
      'far',
      'unknown',
    ]);
  });
});
