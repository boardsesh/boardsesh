import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { QuickstartScanDevice } from '../../../lib/ble/quickstart-scan-device';
import type { RecognizedBoardDevice } from '../../../lib/ble/recognized-board-devices-store';
import {
  buildQuickstartRows,
  builderSerialForRow,
  carryDrawnAnswer,
  quickstartLookupState,
  type QuickstartLookupState,
} from '../quickstart-scan-rows';

function serialDevice(
  serial: string,
  boardType: 'kilter' | 'tension' | null,
  rssi: number | null,
): QuickstartScanDevice {
  return {
    key: `serial:${serial}`,
    deviceId: `id-${serial}`,
    name: `Board#${serial}@3`,
    kind: 'serial',
    serial,
    boardType,
    rssi,
  };
}

function moonboard(deviceId: string, rssi: number | null): QuickstartScanDevice {
  return {
    key: `device:${deviceId}`,
    deviceId,
    name: 'MoonBoard A',
    kind: 'moonboard',
    serial: null,
    boardType: 'moonboard',
    rssi,
  };
}

function bareBox(deviceId: string, boardType: 'kilter' | 'tension', rssi: number | null): QuickstartScanDevice {
  return {
    key: `device:${deviceId}`,
    deviceId,
    name: 'Kilter Board',
    kind: 'bare_name',
    serial: null,
    boardType,
    rssi,
  };
}

function savedBoard(uuid: string, serialNumber: string): UserBoard {
  return { uuid, serialNumber, name: uuid, boardType: 'kilter' } as unknown as UserBoard;
}

const kinds = (rows: ReturnType<typeof buildQuickstartRows>) =>
  rows.map((row) =>
    row.kind === 'board'
      ? `board:${row.board.uuid}`
      : row.kind === 'lookup_failed'
        ? row.kind
        : `${row.kind}:${row.boardType}`,
  );

describe('buildQuickstartRows', () => {
  it('lists saved boards for resolved serials, and the rest by type', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50), serialDevice('2', 'tension', -60)],
      boards: [savedBoard('crux', '1')],
      lookup: 'resolved',
    });
    expect(kinds(rows)).toEqual(['board:crux', 'unknown_setup:tension']);
    expect(rows[0].rssi).toBe(-50);
  });

  // Its next steps are "find it at my gym" and "it's my own board" for a TYPE,
  // so a serial whose name named no type has nothing to offer.
  it('gives a serial whose name named no type no row', () => {
    const rows = buildQuickstartRows({ devices: [serialDevice('1', null, -50)], boards: [], lookup: 'resolved' });
    expect(rows).toEqual([]);
  });

  it('folds boards it cannot name into one row per type, at the strongest signal', () => {
    const rows = buildQuickstartRows({
      devices: [
        moonboard('mb-1', -80),
        moonboard('mb-2', -45),
        bareBox('kb-1', 'kilter', -70),
        bareBox('kb-2', 'kilter', -65),
        bareBox('tb-1', 'tension', -90),
        serialDevice('3', 'kilter', -75),
        serialDevice('4', 'kilter', -40),
      ],
      boards: [],
      lookup: 'resolved',
    });
    expect(kinds(rows)).toEqual([
      'unknown_setup:kilter',
      'moonboard:moonboard',
      'bare_name:kilter',
      'bare_name:tension',
    ]);
    expect(rows.map((row) => row.rssi)).toEqual([-40, -45, -65, -90]);
  });

  // The picker binds the box to the board picked next, so it needs the box's
  // id, and only when one box stands behind the row.
  it.each([
    { name: 'one MoonBoard', devices: [moonboard('mb-1', -60)], expected: 'mb-1' },
    { name: 'two MoonBoards', devices: [moonboard('mb-1', -60), moonboard('mb-2', -50)], expected: null },
    { name: 'one bare Kilter box', devices: [bareBox('kb-1', 'kilter', -60)], expected: 'kb-1' },
    {
      name: 'two bare Kilter boxes',
      devices: [bareBox('kb-1', 'kilter', -60), bareBox('kb-2', 'kilter', -70)],
      expected: null,
    },
  ])('carries the box id for $name: $expected', ({ devices, expected }) => {
    const [row] = buildQuickstartRows({ devices, boards: [], lookup: 'none' });
    expect(row.kind === 'moonboard' || row.kind === 'bare_name' ? row.deviceId : 'no id field').toBe(expected);
  });

  it('keeps the box ids of two board types apart', () => {
    const rows = buildQuickstartRows({
      devices: [bareBox('kb-1', 'kilter', -60), bareBox('tb-1', 'tension', -70)],
      boards: [],
      lookup: 'none',
    });
    expect(rows.map((row) => (row.kind === 'bare_name' ? row.deviceId : null))).toEqual(['kb-1', 'tb-1']);
  });

  it('holds serial rows back while the lookup is pending, but not the boards with no serial', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50), moonboard('mb-1', -70)],
      boards: [savedBoard('crux', '1')],
      lookup: 'pending',
    });
    expect(kinds(rows)).toEqual(['moonboard:moonboard']);
  });

  it('puts one need-signal row in place of every serial when the lookup failed', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -70), serialDevice('2', 'tension', -55), moonboard('mb-1', -60)],
      boards: [],
      lookup: 'failed',
    });
    expect(kinds(rows)).toEqual(['lookup_failed', 'moonboard:moonboard']);
    expect(rows[0].rssi).toBe(-55);
  });

  // A serial heard after the answer was drawn: the answer's rows stay, and the
  // new serial waits for its own answer instead of reading as unknown.
  it('keeps the drawn answer while a serial heard since is looked up', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50), serialDevice('2', 'tension', -40), serialDevice('3', 'kilter', -60)],
      boards: [savedBoard('crux', '1')],
      answeredSerials: ['1', '3'],
      lookup: 'updating',
    });
    expect(kinds(rows)).toEqual(['board:crux', 'unknown_setup:kilter']);
    expect(rows.map((row) => row.rssi)).toEqual([-50, -60]);
  });

  it('keeps the drawn answer and asks for signal only for the serials heard since', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50), serialDevice('2', 'tension', -70), serialDevice('3', 'kilter', -65)],
      boards: [savedBoard('crux', '1')],
      answeredSerials: ['1'],
      lookup: 'failed',
    });
    expect(kinds(rows)).toEqual(['board:crux', 'lookup_failed']);
    expect(rows[1].rssi).toBe(-65);
  });

  it('sorts every row by signal, strongest first, unknown last', () => {
    const rows = buildQuickstartRows({
      devices: [moonboard('mb-1', null), serialDevice('1', 'kilter', -80), bareBox('kb-1', 'kilter', -50)],
      boards: [savedBoard('crux', '1')],
      lookup: 'resolved',
    });
    expect(kinds(rows)).toEqual(['bare_name:kilter', 'board:crux', 'moonboard:moonboard']);
  });

  it('gives each saved board its own key, even two the lookup could not name', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50)],
      boards: [savedBoard('', '1'), savedBoard('', '1')],
      lookup: 'resolved',
    });
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('lists nothing when nothing was heard', () => {
    expect(buildQuickstartRows({ devices: [], boards: [], lookup: 'none' })).toEqual([]);
  });

  it('says a serial row is known by its serial', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50)],
      boards: [savedBoard('crux', '1')],
      lookup: 'resolved',
    });
    expect(rows[0]).toMatchObject({ kind: 'board', recognizedBy: 'serial' });
  });
});

// A serial-less box this phone has bound to one of the climber's boards is
// named by its Bluetooth id (recognized-board-devices-store.ts).
// The builder opens with the serial of a box nobody has saved only when that
// box is the one box of its type heard: with two, the signal can't say which
// one the climber stands at.
describe('the serial an unknown box hands the builder', () => {
  type UnknownSetupRow = Extract<ReturnType<typeof buildQuickstartRows>[number], { kind: 'unknown_setup' }>;
  function unknownRow(devices: QuickstartScanDevice[], boardType: 'kilter' | 'tension' = 'kilter'): UnknownSetupRow {
    const rows = buildQuickstartRows({ devices, boards: [], lookup: 'resolved' });
    const row = rows.find((candidate) => candidate.kind === 'unknown_setup' && candidate.boardType === boardType);
    if (!row || row.kind !== 'unknown_setup') throw new Error(`no unknown_setup row for ${boardType}`);
    return row;
  }

  it('carries every unsaved serial of its type, once each, in the order heard', () => {
    const row = unknownRow([
      serialDevice('751737', 'kilter', -50),
      serialDevice('T-9', 'tension', -40),
      serialDevice('800001', 'kilter', -70),
      serialDevice('751737', 'kilter', -45),
    ]);
    expect(row.serials).toEqual(['751737', '800001']);
  });

  it('never carries a serial that named a saved board', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('1', 'kilter', -50), serialDevice('2', 'kilter', -60)],
      boards: [savedBoard('crux', '1')],
      lookup: 'resolved',
    });
    const unknown = rows.find((row) => row.kind === 'unknown_setup');
    expect(unknown?.kind === 'unknown_setup' ? unknown.serials : null).toEqual(['2']);
  });

  it.each<{ name: string; devices: QuickstartScanDevice[]; listenedLongEnough: boolean; expected: string | null }>([
    {
      name: 'one box heard long enough: its serial',
      devices: [serialDevice('751737', 'kilter', -50)],
      listenedLongEnough: true,
      expected: '751737',
    },
    {
      name: 'one box, but a scan cut short: nothing, a second may not have been heard yet',
      devices: [serialDevice('751737', 'kilter', -50)],
      listenedLongEnough: false,
      expected: null,
    },
    {
      name: 'two boxes of the type: nothing',
      devices: [serialDevice('751737', 'kilter', -50), serialDevice('800001', 'kilter', -60)],
      listenedLongEnough: true,
      expected: null,
    },
    {
      name: 'one box of the type beside one of another type: its serial',
      devices: [serialDevice('751737', 'kilter', -50), serialDevice('T-9', 'tension', -40)],
      listenedLongEnough: true,
      expected: '751737',
    },
  ])('$name', ({ devices, listenedLongEnough, expected }) => {
    expect(builderSerialForRow(unknownRow(devices), listenedLongEnough, 'resolved')).toBe(expected);
  });

  it('counts a box the lookup has not answered: two unsaved boxes, one lookup failed, give nothing', () => {
    const rows = buildQuickstartRows({
      devices: [serialDevice('751737', 'kilter', -50), serialDevice('800001', 'kilter', -60)],
      boards: [],
      answeredSerials: ['751737'],
      lookup: 'failed',
    });
    const row = rows.find((candidate) => candidate.kind === 'unknown_setup');
    if (!row || row.kind !== 'unknown_setup') throw new Error('no unknown_setup row');
    expect(row.serials).toEqual(['751737', '800001']);
    expect(builderSerialForRow(row, true, 'failed')).toBeNull();
    // Even read as answered, two boxes are two boxes.
    expect(builderSerialForRow(row, true, 'resolved')).toBeNull();
  });

  it.each<QuickstartLookupState>(['none', 'pending', 'updating', 'failed'])(
    'gives nothing until the lookup has answered every serial (%s)',
    (lookup) => {
      expect(builderSerialForRow(unknownRow([serialDevice('751737', 'kilter', -50)]), true, lookup)).toBeNull();
    },
  );

  it('counts a bare-name box of the same type: a serial box beside one gives nothing', () => {
    const row = unknownRow([serialDevice('751737', 'kilter', -50), bareBox('BARE-1', 'kilter', -60)]);
    expect(row.serialLessBoxCount).toBe(1);
    expect(builderSerialForRow(row, true, 'resolved')).toBeNull();
  });

  it('does not count a bare-name box of another type', () => {
    const row = unknownRow([serialDevice('751737', 'kilter', -50), bareBox('BARE-1', 'tension', -60)]);
    expect(row.serialLessBoxCount).toBe(0);
    expect(builderSerialForRow(row, true, 'resolved')).toBe('751737');
  });

  it('gives nothing for a row with no serial behind it', () => {
    expect(
      builderSerialForRow({ ...unknownRow([serialDevice('1', 'kilter', -50)]), serials: [] }, true, 'resolved'),
    ).toBeNull();
    expect(
      builderSerialForRow(
        { kind: 'moonboard', key: 'moonboard:moonboard', boardType: 'moonboard', rssi: -50, deviceId: 'MOON' },
        true,
        'resolved',
      ),
    ).toBeNull();
    expect(
      builderSerialForRow(
        { kind: 'bare_name', key: 'bare_name:kilter', boardType: 'kilter', rssi: -50, deviceId: 'BOX' },
        true,
        'resolved',
      ),
    ).toBeNull();
  });
});

describe('buildQuickstartRows with recognised Bluetooth ids', () => {
  function ownBoard(uuid: string, boardType: string): UserBoard {
    return { uuid, name: uuid, boardType, serialNumber: null } as unknown as UserBoard;
  }

  function recognized(deviceId: string, boardUuid: string, boardType: 'moonboard' | 'kilter'): RecognizedBoardDevice {
    return { deviceId: deviceId.toUpperCase(), boardUuid, boardType, savedAt: 1 };
  }

  const homeMoon = ownBoard('home-moon', 'moonboard');
  const gymKilter = ownBoard('gym-kilter', 'kilter');

  type RecognitionCase = {
    name: string;
    devices: QuickstartScanDevice[];
    recognizedDevices: RecognizedBoardDevice[];
    knownBoards: UserBoard[];
    boards?: UserBoard[];
    lookup?: QuickstartLookupState;
    expected: string[];
    expectedRecognizedBy?: Array<'serial' | 'device_id' | null>;
  };

  const cases: RecognitionCase[] = [
    {
      name: 'names a recognised MoonBoard as the board it was bound to',
      devices: [moonboard('mb-1', -60)],
      recognizedDevices: [recognized('mb-1', 'home-moon', 'moonboard')],
      knownBoards: [homeMoon],
      expected: ['board:home-moon'],
      expectedRecognizedBy: ['device_id'],
    },
    {
      name: 'names a recognised bare Kilter box',
      devices: [bareBox('kb-1', 'kilter', -60)],
      recognizedDevices: [recognized('kb-1', 'gym-kilter', 'kilter')],
      knownBoards: [gymKilter],
      expected: ['board:gym-kilter'],
      expectedRecognizedBy: ['device_id'],
    },
    {
      name: 'keeps the grouped row for the boxes it does not recognise, and not for the one it does',
      devices: [moonboard('mb-1', -60), moonboard('mb-2', -50)],
      recognizedDevices: [recognized('mb-1', 'home-moon', 'moonboard')],
      knownBoards: [homeMoon],
      expected: ['moonboard:moonboard', 'board:home-moon'],
      expectedRecognizedBy: [null, 'device_id'],
    },
    {
      name: 'leaves a box unnamed when its board is no longer one of the known boards',
      devices: [moonboard('mb-1', -60)],
      recognizedDevices: [recognized('mb-1', 'home-moon', 'moonboard')],
      knownBoards: [gymKilter],
      expected: ['moonboard:moonboard'],
    },
    {
      name: 'leaves a box unnamed when its id was recognised as another type',
      devices: [bareBox('mb-1', 'kilter', -60)],
      recognizedDevices: [recognized('mb-1', 'home-moon', 'moonboard')],
      knownBoards: [homeMoon],
      expected: ['bare_name:kilter'],
    },
    {
      name: 'leaves a box unnamed when the known board is of another type than the box',
      devices: [moonboard('mb-1', -60)],
      recognizedDevices: [recognized('mb-1', 'gym-kilter', 'moonboard')],
      knownBoards: [gymKilter],
      expected: ['moonboard:moonboard'],
    },
    {
      name: 'matches the id whatever its case',
      devices: [moonboard('aa:bb:cc', -60)],
      recognizedDevices: [recognized('AA:BB:CC', 'home-moon', 'moonboard')],
      knownBoards: [homeMoon],
      expected: ['board:home-moon'],
    },
    {
      name: 'lists one row for two boxes recognised as one board, at the stronger signal',
      devices: [moonboard('mb-1', -80), moonboard('mb-2', -40)],
      recognizedDevices: [recognized('mb-1', 'home-moon', 'moonboard'), recognized('mb-2', 'home-moon', 'moonboard')],
      knownBoards: [homeMoon],
      expected: ['board:home-moon'],
    },
    {
      name: 'does not wait for the serial lookup',
      devices: [moonboard('mb-1', -60), serialDevice('1', 'kilter', -50)],
      recognizedDevices: [recognized('mb-1', 'home-moon', 'moonboard')],
      knownBoards: [homeMoon],
      lookup: 'pending',
      expected: ['board:home-moon'],
    },
    {
      name: 'lists a board heard both ways once, by serial',
      devices: [bareBox('kb-1', 'kilter', -40), serialDevice('7', 'kilter', -70)],
      recognizedDevices: [recognized('kb-1', 'gym-kilter', 'kilter')],
      knownBoards: [gymKilter],
      boards: [{ ...gymKilter, serialNumber: '7' } as UserBoard],
      lookup: 'resolved',
      expected: ['board:gym-kilter'],
      expectedRecognizedBy: ['serial'],
    },
    {
      name: 'names nothing without known boards',
      devices: [moonboard('mb-1', -60)],
      recognizedDevices: [recognized('mb-1', 'home-moon', 'moonboard')],
      knownBoards: [],
      expected: ['moonboard:moonboard'],
    },
  ];

  it.each(cases)(
    '$name',
    ({ devices, recognizedDevices, knownBoards, boards, lookup, expected, expectedRecognizedBy }) => {
      const rows = buildQuickstartRows({
        devices,
        boards: boards ?? [],
        lookup: lookup ?? 'none',
        recognition: { devices: recognizedDevices, knownBoards },
      });
      expect(kinds(rows)).toEqual(expected);
      if (expectedRecognizedBy) {
        expect(rows.map((row) => (row.kind === 'board' ? row.recognizedBy : null))).toEqual(expectedRecognizedBy);
      }
    },
  );

  it('keeps the stronger signal when a board is heard both ways', () => {
    const rows = buildQuickstartRows({
      devices: [bareBox('kb-1', 'kilter', -40), serialDevice('7', 'kilter', -70)],
      boards: [{ ...gymKilter, serialNumber: '7' } as UserBoard],
      lookup: 'resolved',
      recognition: { devices: [recognized('kb-1', 'gym-kilter', 'kilter')], knownBoards: [gymKilter] },
    });
    expect(rows[0].rssi).toBe(-40);
  });

  it('keys a recognised row like the serial row it may turn into', () => {
    const recognition = { devices: [recognized('kb-1', 'gym-kilter', 'kilter')], knownBoards: [gymKilter] };
    const devices = [bareBox('kb-1', 'kilter', -40), serialDevice('7', 'kilter', -70)];
    const before = buildQuickstartRows({ devices, boards: [], lookup: 'pending', recognition });
    const after = buildQuickstartRows({
      devices,
      boards: [{ ...gymKilter, serialNumber: '7' } as UserBoard],
      lookup: 'resolved',
      recognition,
    });
    expect(before[0].key).toBe(after[0].key);
  });

  it('recognises nothing when the caller passes no recognition, as the quickstart sheet does', () => {
    const rows = buildQuickstartRows({ devices: [moonboard('mb-1', -60)], boards: [], lookup: 'none' });
    expect(kinds(rows)).toEqual(['moonboard:moonboard']);
  });
});

describe('quickstartLookupState', () => {
  const base = { serialCount: 1, hasResult: false, failed: false, resolving: false };

  it('has nothing to look up without a serial', () => {
    expect(quickstartLookupState({ ...base, serialCount: 0, failed: true })).toBe('none');
  });

  it('is pending while the request runs', () => {
    expect(quickstartLookupState({ ...base, resolving: true })).toBe('pending');
  });

  // Offline, `networkMode: 'offlineFirst'` pauses the request: no error, no
  // data, not loading. That used to read as "No boards in range".
  it('is failed when the request paused or errored with no answer', () => {
    expect(quickstartLookupState({ ...base, failed: true })).toBe('failed');
  });

  it('keeps an answer it already has through a failed refetch', () => {
    expect(quickstartLookupState({ ...base, hasResult: true, failed: true })).toBe('resolved');
  });

  it('waits for the saved serial choices before calling an answer resolved', () => {
    expect(quickstartLookupState({ ...base, hasResult: true, resolving: true })).toBe('pending');
  });
});

describe('carryDrawnAnswer', () => {
  const drawn = { serials: ['1'], boards: [savedBoard('crux', '1')] };

  it.each<{
    name: string;
    lookup: QuickstartLookupState;
    serials: string[];
    /** Whether an answer for serial 1 was drawn earlier. */
    drewBefore: boolean;
    expected: QuickstartLookupState;
    keepsAnswer: boolean;
  }>([
    {
      name: 'first answer out',
      lookup: 'pending',
      serials: ['1'],
      drewBefore: false,
      expected: 'pending',
      keepsAnswer: false,
    },
    {
      name: 'new serial looked up',
      lookup: 'pending',
      serials: ['1', '2'],
      drewBefore: true,
      expected: 'updating',
      keepsAnswer: true,
    },
    {
      name: 'new serial failed',
      lookup: 'failed',
      serials: ['1', '2'],
      drewBefore: true,
      expected: 'failed',
      keepsAnswer: true,
    },
    {
      name: 'every serial answered',
      lookup: 'resolved',
      serials: ['1'],
      drewBefore: true,
      expected: 'resolved',
      keepsAnswer: true,
    },
    // A new scan starts empty, and one that hears other serials never draws
    // the last scan's boards, even once it hears that scan's serial again.
    {
      name: 'new scan, nothing heard',
      lookup: 'none',
      serials: [],
      drewBefore: true,
      expected: 'none',
      keepsAnswer: false,
    },
    {
      name: 'new scan, other serials',
      lookup: 'pending',
      serials: ['2'],
      drewBefore: true,
      expected: 'pending',
      keepsAnswer: false,
    },
    {
      name: 'new scan, other serial then the old one',
      lookup: 'pending',
      serials: ['2', '1'],
      drewBefore: true,
      expected: 'pending',
      keepsAnswer: false,
    },
  ])('$name: $expected', ({ lookup, serials, drewBefore, expected, keepsAnswer }) => {
    const carried = carryDrawnAnswer({ lookup, serials, drawn: drewBefore ? drawn : null });
    expect(carried.lookup).toBe(expected);
    expect(carried.answer).toBe(keepsAnswer ? drawn : null);
  });
});
