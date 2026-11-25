import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  buildPickerTopView,
  collapsedRows,
  decidePickerTop,
  decisionAtDrawnTop,
  gymMostHeard,
  isSameBoard,
  mapPickerTopBoards,
  pickerTopBoardUuids,
  pickerTopGymUuid,
  pickerTopPicks,
  pickerTopSignature,
  pickerTopView,
  stabilizePickerTop,
  type InRangeBoardRow,
  type PickerTopBoard,
  type PickerTopInputs,
  type PickerTopView,
} from '../picker-top-view';
import type { PickerScanPhase } from '../picker-scan-phase';
import type { QuickstartRow } from '../quickstart-scan-rows';

type Gym = { uuid: string; name: string };
const CRUX: Gym = { uuid: 'gym-crux', name: 'Crux' };
const BLOC: Gym = { uuid: 'gym-bloc', name: 'Bloc' };

function board(uuid: string, gym: Gym | null = null, overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid,
    name: uuid,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    gymUuid: gym?.uuid ?? null,
    gymName: gym?.name ?? null,
    ...overrides,
  } as unknown as UserBoard;
}

function heard(target: UserBoard, rssi = -50): InRangeBoardRow {
  return { kind: 'board', key: `board:${target.uuid}`, board: target, rssi, recognizedBy: 'serial' };
}

const MOONBOARD_ROW: QuickstartRow = {
  kind: 'moonboard',
  key: 'moonboard:moonboard',
  boardType: 'moonboard',
  rssi: -55,
  deviceId: 'MOON-BOX',
};
const BARE_KILTER_ROW: QuickstartRow = {
  kind: 'bare_name',
  key: 'bare_name:kilter',
  boardType: 'kilter',
  rssi: -60,
  deviceId: null,
};
const UNKNOWN_SETUP_ROW: QuickstartRow = {
  kind: 'unknown_setup',
  key: 'unknown_setup:tension',
  boardType: 'tension',
  rssi: -45,
  serials: ['T-1'],
  serialLessBoxCount: 0,
};
const LOOKUP_FAILED_ROW: QuickstartRow = { kind: 'lookup_failed', key: 'lookup_failed', rssi: -40 };

const cruxKilter = board('crux-kilter', CRUX);
const cruxTension = board('crux-tension', CRUX);
const cruxMoon = board('crux-moon', CRUX);
const blocKilter = board('bloc-kilter', BLOC);
const blocTension = board('bloc-tension', BLOC);
const homeWall = board('home-wall');
const friendsWall = board('friends-wall');

/**
 * The top in one line: the notice, the box it can't name, what leads (with its
 * gym, source and rows, `*` on the selected one) and the spinner. A hero that
 * isn't the strongest signal heard reads `~nearby`.
 */
function summarize(view: PickerTopView<PickerTopBoard>): string {
  const { notice, unnamed, content, scanning } = view;
  let lead: string;
  switch (content.kind) {
    case 'at_gym':
      lead = `at_gym:${content.gymName}/${content.source}[${content.rows
        .map((row) => `${row.board.uuid}${row.selected ? '*' : ''}`)
        .join(',')}]`;
      break;
    case 'hero':
      lead = `hero:${content.board.board.uuid}${content.strongestSignal ? '' : '~nearby'}`;
      break;
    default:
      lead = content.kind;
  }
  const noticeText =
    notice === null
      ? ''
      : `${notice.kind}${notice.kind === 'lookup_failed' && notice.besideHeardBoards ? '(beside)' : ''} + `;
  const unnamedText = unnamed === null ? '' : `unnamed:${unnamed.key} + `;
  return `${noticeText}${unnamedText}${lead}${scanning ? ' (scanning)' : ''}`;
}

function top(inputs: Partial<PickerTopInputs>, gymRoster?: readonly UserBoard[]): string {
  return summarize(
    pickerTopView({ phase: 'done', rows: [], lookup: 'resolved', activeBoard: null, ...inputs }, gymRoster),
  );
}

describe('which gym the top is at', () => {
  it('lists the gym most of the named boards heard belong to', () => {
    expect(top({ rows: [heard(blocKilter, -40), heard(cruxKilter), heard(cruxTension)] })).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-tension]',
    );
  });

  // Two Crux walls and two Bloc walls: the board you're on settles it.
  it('settles a tie on the gym of the board you are on, when it is one of the tied', () => {
    const rows = [heard(blocKilter, -40), heard(blocTension, -45), heard(cruxKilter, -60), heard(cruxTension, -65)];
    expect(top({ rows, activeBoard: cruxMoon })).toBe('at_gym:Crux/scan[crux-kilter,crux-moon*,crux-tension]');
  });

  it('settles a tie on the strongest signal when the board you are on is at neither gym', () => {
    // The rows arrive strongest first, as buildQuickstartRows sorts them: Bloc's Kilter leads.
    const rows = [heard(blocKilter, -40), heard(cruxKilter, -60), heard(cruxTension, -65), heard(blocTension, -70)];
    expect(top({ rows, activeBoard: homeWall })).toBe('at_gym:Bloc/scan[bloc-kilter,bloc-tension]');
  });

  it('falls back to the gym of the board you are on when nothing named is heard', () => {
    expect(top({ rows: [], activeBoard: cruxKilter })).toBe('at_gym:Crux/active_board[crux-kilter*]');
  });

  // Home walls name no gym: the strongest is the hero, as one board would be.
  it('leads with the strongest when the named boards heard have no gym', () => {
    expect(top({ rows: [heard(friendsWall), heard(homeWall)], activeBoard: cruxKilter })).toBe('hero:friends-wall');
    expect(top({ rows: [heard(friendsWall), heard(homeWall)], activeBoard: null })).toBe('hero:friends-wall');
  });

  // The board you're on is right there, and Your boards marks it.
  it('shows nothing when those gymless boards include the one you are on', () => {
    expect(top({ rows: [heard(friendsWall), heard(homeWall)], activeBoard: homeWall })).toBe('none');
    expect(
      top({
        phase: 'scanning',
        lookup: 'resolved',
        rows: [heard(friendsWall), heard(homeWall)],
        activeBoard: homeWall,
      }),
    ).toBe('none (scanning)');
  });

  it('counts a board as at a gym only when it carries the gym name too', () => {
    const unnamedGymBoard = board('no-name', { uuid: 'gym-x', name: '' });
    expect(top({ rows: [heard(unnamedGymBoard), heard(cruxKilter)], activeBoard: homeWall })).toBe(
      'at_gym:Crux/scan[crux-kilter]',
    );
  });

  it('gymMostHeard answers null when no named board has a gym', () => {
    expect(gymMostHeard([heard(homeWall), heard(friendsWall)], null)).toBeNull();
  });
});

describe('one named board heard', () => {
  // The other-gym hero: on your garage board, a Crux wall in front of you.
  it('is the hero when it is neither the board you are on nor at its gym', () => {
    expect(top({ rows: [heard(cruxKilter)], activeBoard: homeWall })).toBe('hero:crux-kilter');
    expect(top({ rows: [heard(cruxKilter)], activeBoard: blocKilter })).toBe('hero:crux-kilter');
    expect(top({ rows: [heard(cruxKilter)], activeBoard: null })).toBe('hero:crux-kilter');
    // A wall with no gym, someone else's: still the board in front of you.
    expect(top({ rows: [heard(friendsWall)], activeBoard: homeWall })).toBe('hero:friends-wall');
  });

  it('is At {gym} when it is at the gym of the board you are on', () => {
    expect(top({ rows: [heard(cruxKilter)], activeBoard: cruxMoon })).toBe('at_gym:Crux/scan[crux-kilter,crux-moon*]');
  });

  it('is At {gym} when it is the board you are on', () => {
    expect(top({ rows: [heard(cruxKilter)], activeBoard: cruxKilter })).toBe('at_gym:Crux/scan[crux-kilter*]');
  });

  // Your home wall in front of you: nothing new to show above Your boards.
  it('shows nothing when it is the board you are on and it has no gym', () => {
    expect(top({ rows: [heard(homeWall)], activeBoard: homeWall })).toBe('none');
  });

  // A hidden board found by serial has no uuid: it is the same board by serial.
  it('tells the board you are on by its serial when the heard copy has no uuid', () => {
    const active = board('crux-hidden', CRUX, { serialNumber: 'S1' });
    const geometryOnly = board('', null, { serialNumber: 'S1' });
    expect(top({ rows: [heard(geometryOnly)], activeBoard: active })).toBe('at_gym:Crux/active_board[crux-hidden*]');
  });
});

describe('which board is the same board', () => {
  it('compares uuids when both have one', () => {
    expect(isSameBoard(cruxKilter, board('crux-kilter', BLOC))).toBe(true);
    expect(isSameBoard(cruxKilter, cruxTension)).toBe(false);
  });

  // A Kilter box and a Tension box can share a serial.
  it('compares the serial and the board type when one has no uuid', () => {
    const kilterBySerial = board('', null, { serialNumber: 'S1', boardType: 'kilter' });
    expect(isSameBoard(kilterBySerial, board('mine', null, { serialNumber: 'S1', boardType: 'kilter' }))).toBe(true);
    expect(isSameBoard(kilterBySerial, board('mine', null, { serialNumber: 'S1', boardType: 'tension' }))).toBe(false);
    expect(isSameBoard(kilterBySerial, board('mine', null, { serialNumber: 'S2', boardType: 'kilter' }))).toBe(false);
    expect(isSameBoard(board(''), board(''))).toBe(false);
  });
});

describe('"In front of you" or "Nearby"', () => {
  it('says the hero is in front of you only when nothing was heard louder', () => {
    expect(top({ rows: [heard(cruxKilter), MOONBOARD_ROW], activeBoard: homeWall })).toBe('hero:crux-kilter');
    expect(top({ rows: [MOONBOARD_ROW, heard(cruxKilter)], activeBoard: homeWall })).toBe('hero:crux-kilter~nearby');
    expect(top({ rows: [LOOKUP_FAILED_ROW, heard(cruxKilter)], lookup: 'failed', activeBoard: homeWall })).toBe(
      'lookup_failed(beside) + hero:crux-kilter~nearby',
    );
  });

  // So a hero held from earlier in the scan can say it from what is heard now.
  it('names the loudest thing heard when it is a board it can name', () => {
    const loudest = (inputs: Partial<PickerTopInputs>) =>
      decidePickerTop({ phase: 'scanning', rows: [], lookup: 'resolved', activeBoard: homeWall, ...inputs })
        .loudestBoardKey;
    expect(loudest({ rows: [heard(cruxKilter), MOONBOARD_ROW] })).toBe('crux-kilter');
    expect(loudest({ rows: [MOONBOARD_ROW, heard(cruxKilter)] })).toBeNull();
    expect(loudest({ rows: [heard(cruxKilter)], holdScanLead: true })).toBeNull();
    expect(loudest({ rows: [heard(cruxKilter)], phase: 'tap_to_scan' })).toBeNull();
  });
});

describe('boxes it cannot name', () => {
  it.each([MOONBOARD_ROW, BARE_KILTER_ROW, UNKNOWN_SETUP_ROW])('shows $kind when nothing named was heard', (row) => {
    expect(top({ rows: [row] })).toBe(`unnamed:${row.key} + none`);
    expect(top({ rows: [row], activeBoard: homeWall })).toBe(`unnamed:${row.key} + none`);
  });

  it('takes the strongest of several', () => {
    expect(top({ rows: [UNKNOWN_SETUP_ROW, MOONBOARD_ROW] })).toBe('unnamed:unknown_setup:tension + none');
  });

  // The gym the board you're on names doesn't say what this box is: its card
  // goes above At {gym}.
  it('shows above At {gym} when the gym comes from the board you are on', () => {
    expect(top({ rows: [MOONBOARD_ROW], activeBoard: cruxKilter })).toBe(
      'unnamed:moonboard:moonboard + at_gym:Crux/active_board[crux-kilter*]',
    );
  });

  it('is ignored beside a named board', () => {
    expect(top({ rows: [heard(cruxKilter), MOONBOARD_ROW], activeBoard: homeWall })).toBe('hero:crux-kilter');
    expect(top({ rows: [MOONBOARD_ROW, heard(cruxKilter), heard(cruxTension)] })).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-tension]',
    );
    // Even one that names no gym: it is the board you're on, right there.
    expect(top({ rows: [MOONBOARD_ROW, heard(homeWall)], activeBoard: homeWall })).toBe('none');
  });

  it('replaces the placeholder while scanning', () => {
    expect(top({ phase: 'scanning', lookup: 'none', rows: [MOONBOARD_ROW] })).toBe(
      'unnamed:moonboard:moonboard + none (scanning)',
    );
  });
});

describe('the scan phases', () => {
  it.each<{ phase: PickerScanPhase; expected: string }>([
    { phase: 'hidden', expected: 'none' },
    { phase: 'needs_permission', expected: 'permission_card + none' },
    { phase: 'blocked_denied', expected: 'blocked_denied + none' },
    { phase: 'blocked_off', expected: 'blocked_off + none' },
    { phase: 'unreachable', expected: 'unreachable + none' },
    { phase: 'tap_to_scan', expected: 'tap_to_scan + none' },
  ])('$phase passes its notice through, with no gym known', ({ phase, expected }) => {
    // Rows left over from an earlier scan say nothing about now.
    expect(top({ phase, rows: [heard(cruxKilter), MOONBOARD_ROW] })).toBe(expected);
  });

  // The `picker-auto-scan-kill` switch leaves the scan waiting for a tap: the
  // gym of the board you're on still shows, under the Scan card.
  it.each<{ phase: PickerScanPhase; expected: string }>([
    { phase: 'hidden', expected: 'at_gym:Crux/active_board[crux-kilter*]' },
    { phase: 'tap_to_scan', expected: 'tap_to_scan + at_gym:Crux/active_board[crux-kilter*]' },
    { phase: 'needs_permission', expected: 'permission_card + at_gym:Crux/active_board[crux-kilter*]' },
    { phase: 'blocked_off', expected: 'blocked_off + at_gym:Crux/active_board[crux-kilter*]' },
  ])('$phase still lists the gym of the board you are on', ({ phase, expected }) => {
    expect(top({ phase, activeBoard: cruxKilter })).toBe(expected);
  });

  // After Not now the card is one line with Allow Bluetooth, and it never goes:
  // a board can't be lit without Bluetooth.
  it.each<{ phase: PickerScanPhase; expected: string }>([
    { phase: 'needs_permission', expected: 'permission_line + none' },
    { phase: 'blocked_denied', expected: 'blocked_denied + none' },
    { phase: 'blocked_off', expected: 'blocked_off + none' },
    { phase: 'tap_to_scan', expected: 'tap_to_scan + none' },
  ])('after Not now, $phase shows $expected', ({ phase, expected }) => {
    expect(top({ phase, bluetoothNotNow: true })).toBe(expected);
  });

  it('keeps the one-line ask above the gym of the board you are on after Not now', () => {
    expect(top({ phase: 'needs_permission', activeBoard: cruxKilter, bluetoothNotNow: true })).toBe(
      'permission_line + at_gym:Crux/active_board[crux-kilter*]',
    );
  });

  it('holds the placeholder while scanning for a climber with no board yet', () => {
    expect(top({ phase: 'scanning', lookup: 'none' })).toBe('looking (scanning)');
  });

  // A climber on a home wall has Your boards to look at; the scan may hear nothing new.
  it('reserves no placeholder for a climber on a board with no gym', () => {
    expect(top({ phase: 'scanning', lookup: 'none', activeBoard: homeWall })).toBe('none (scanning)');
    expect(top({ phase: 'scanning', lookup: 'resolved', rows: [heard(homeWall)], activeBoard: homeWall })).toBe(
      'none (scanning)',
    );
  });

  it('lists the gym of the active board while scanning, with the spinner', () => {
    expect(top({ phase: 'scanning', lookup: 'none', activeBoard: cruxKilter })).toBe(
      'at_gym:Crux/active_board[crux-kilter*] (scanning)',
    );
  });

  // The first answer could point at another gym: nothing heard counts yet.
  it('ignores the rows while the first lookup is out', () => {
    const rows = [heard(blocKilter), heard(blocTension)];
    expect(top({ phase: 'scanning', lookup: 'pending', rows })).toBe('looking (scanning)');
    expect(top({ phase: 'scanning', lookup: 'pending', rows, activeBoard: cruxKilter })).toBe(
      'at_gym:Crux/active_board[crux-kilter*] (scanning)',
    );
  });

  it('decides from what it heard so far once an answer is drawn', () => {
    expect(top({ phase: 'scanning', lookup: 'updating', rows: [heard(cruxKilter)] })).toBe(
      'hero:crux-kilter (scanning)',
    );
    expect(top({ phase: 'scanning', lookup: 'resolved', rows: [heard(cruxKilter), heard(cruxTension)] })).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-tension] (scanning)',
    );
  });

  // No "No boards in range" line: at home with nothing heard, Your boards leads.
  it('shows nothing when the scan heard nothing and no gym is known', () => {
    const view = pickerTopView({ phase: 'done', rows: [], lookup: 'none', activeBoard: homeWall });
    expect(summarize(view)).toBe('none');
    expect(view.heardNothing).toBe(true);
  });

  it('says it heard nothing only once the scan ended with no rows', () => {
    const heardNothing = (inputs: Partial<PickerTopInputs>) =>
      pickerTopView({ phase: 'done', rows: [], lookup: 'none', activeBoard: null, ...inputs }).heardNothing;
    expect(heardNothing({ activeBoard: cruxKilter })).toBe(true);
    expect(heardNothing({ rows: [MOONBOARD_ROW] })).toBe(false);
    expect(heardNothing({ phase: 'scanning' })).toBe(false);
    expect(heardNothing({ phase: 'tap_to_scan' })).toBe(false);
  });
});

// The first box a scan hears is often the one by the door: for its first
// seconds nothing it heard leads.
describe('while the scan holds', () => {
  const held = (inputs: Partial<PickerTopInputs>) =>
    top({ phase: 'scanning', lookup: 'resolved', holdScanLead: true, ...inputs });

  it('draws nothing the scan heard, only the gym of the board you are on', () => {
    expect(held({ rows: [heard(blocKilter), heard(blocTension)], activeBoard: cruxKilter })).toBe(
      'at_gym:Crux/active_board[crux-kilter*] (scanning)',
    );
    expect(held({ rows: [heard(cruxKilter)], activeBoard: homeWall })).toBe('none (scanning)');
    expect(held({ rows: [MOONBOARD_ROW], activeBoard: homeWall })).toBe('none (scanning)');
    expect(held({ rows: [LOOKUP_FAILED_ROW], lookup: 'failed', activeBoard: homeWall })).toBe('none (scanning)');
  });

  it('keeps the placeholder for a climber with no board yet', () => {
    expect(held({ rows: [heard(cruxKilter)] })).toBe('looking (scanning)');
  });

  it('lets go once the scan has ended', () => {
    expect(top({ phase: 'done', rows: [heard(cruxKilter)], activeBoard: homeWall, holdScanLead: true })).toBe(
      'hero:crux-kilter',
    );
  });
});

describe('serials it could not look up', () => {
  it('is the need-signal card when nothing named is shown', () => {
    expect(top({ rows: [LOOKUP_FAILED_ROW], lookup: 'failed' })).toBe('lookup_failed + none');
    expect(top({ rows: [LOOKUP_FAILED_ROW], lookup: 'failed', activeBoard: cruxKilter })).toBe(
      'lookup_failed + at_gym:Crux/active_board[crux-kilter*]',
    );
  });

  // The card already holds the slot: no placeholder under it.
  it('replaces the placeholder while scanning', () => {
    expect(top({ phase: 'scanning', rows: [LOOKUP_FAILED_ROW], lookup: 'failed' })).toBe(
      'lookup_failed + none (scanning)',
    );
  });

  it('is the compact line beside boards the scan named', () => {
    expect(top({ rows: [heard(cruxKilter), LOOKUP_FAILED_ROW, heard(cruxTension)], lookup: 'failed' })).toBe(
      'lookup_failed(beside) + at_gym:Crux/scan[crux-kilter,crux-tension]',
    );
  });

  it('keeps the box it cannot name beside the card', () => {
    expect(top({ rows: [LOOKUP_FAILED_ROW, MOONBOARD_ROW], lookup: 'failed' })).toBe(
      'lookup_failed + unnamed:moonboard:moonboard + none',
    );
  });
});

describe("At {gym}'s rows", () => {
  const rosterBoard = (uuid: string, name: string) => board(uuid, CRUX, { name });

  it('lists the whole roster A to Z, numbers in number order, the board you are on in place', () => {
    const roster = [
      rosterBoard('wall-10', 'Wall 10'),
      rosterBoard('cave', 'cave'),
      rosterBoard('wall-2', 'Wall 2'),
      rosterBoard('arch', 'Arch'),
    ];
    const view = pickerTopView(
      { phase: 'done', rows: [], lookup: 'none', activeBoard: rosterBoard('wall-2', 'Wall 2') },
      roster,
    );
    expect(summarize(view)).toBe('at_gym:Crux/active_board[arch,cave,wall-2*,wall-10]');
  });

  it('orders by the name the row shows, without the gym prefix', () => {
    const roster = [rosterBoard('kilter', 'Crux - Kilter'), rosterBoard('arch', 'Arch'), rosterBoard('moon', 'Moon')];
    const view = pickerTopView({ phase: 'done', rows: [], lookup: 'none', activeBoard: roster[1] }, roster);
    if (view.content.kind !== 'at_gym') throw new Error('expected At {gym}');
    expect(view.content.rows.map((row) => row.title)).toEqual(['Arch', 'Kilter', 'Moon']);
  });

  // The roster is a narrower read of each board; the board you're on and the
  // boards the scan named are the full ones, and never wait on the roster.
  it('merges the board you are on, the boards heard and the roster, once each, preferring the full copies', () => {
    const narrowCruxKilter = board('crux-kilter', CRUX, { name: 'crux-kilter (roster)' });
    const narrowCruxMoon = board('crux-moon', CRUX, { name: 'crux-moon (roster)' });
    const view = pickerTopView(
      { phase: 'done', rows: [heard(cruxKilter), heard(cruxTension)], lookup: 'resolved', activeBoard: cruxMoon },
      [narrowCruxKilter, narrowCruxMoon, board('crux-spray', CRUX)],
    );
    if (view.content.kind !== 'at_gym') throw new Error('expected At {gym}');
    expect(view.content.rows.map((row) => row.board)).toEqual([
      cruxKilter,
      cruxMoon,
      board('crux-spray', CRUX),
      cruxTension,
    ]);
    // A long gym keeps the walls the scan heard in view.
    expect([...view.content.heardKeys]).toEqual(['crux-kilter', 'crux-tension']);
  });

  it('has rows before the roster lands', () => {
    expect(top({ rows: [heard(cruxKilter), heard(cruxTension)] }, undefined)).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-tension]',
    );
  });

  // A roster React Query still holds for the last gym is not this one's.
  it('leaves out roster boards at another gym', () => {
    expect(top({ activeBoard: cruxKilter }, [blocKilter, cruxTension])).toBe(
      'at_gym:Crux/active_board[crux-kilter*,crux-tension]',
    );
  });

  it('leaves the board you are on out when it is at another gym', () => {
    expect(top({ rows: [heard(cruxKilter), heard(cruxTension)], activeBoard: blocKilter }, [cruxMoon])).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-moon,crux-tension]',
    );
  });
});

describe('two steps: the gym, then its roster', () => {
  it('asks for the roster of the gym it decided on, and none without one', () => {
    const atCrux = decidePickerTop({ phase: 'done', rows: [], lookup: 'none', activeBoard: cruxKilter });
    expect(pickerTopGymUuid(atCrux)).toBe('gym-crux');
    const hero = decidePickerTop({ phase: 'done', rows: [heard(cruxKilter)], lookup: 'resolved', activeBoard: null });
    expect(pickerTopGymUuid(hero)).toBeNull();
    expect(summarize(buildPickerTopView(atCrux, [cruxTension]))).toBe(
      'at_gym:Crux/active_board[crux-kilter*,crux-tension]',
    );
  });
});

// Once the scan has led, what it led with stays for the rest of that scan.
describe('stabilizePickerTop', () => {
  const scanView = (rows: readonly QuickstartRow[], activeBoard: UserBoard | null, roster?: readonly UserBoard[]) =>
    pickerTopView({ phase: 'scanning', rows, lookup: 'resolved', activeBoard }, roster);

  it('passes the top through before the scan has led', () => {
    const next = scanView([heard(cruxKilter)], homeWall);
    expect(stabilizePickerTop(null, next)).toBe(next);
  });

  // Two named walls at a gym are At {gym}: the one move a held hero makes.
  it('lets the hero become At {its own gym}, and no other gym', () => {
    const drawn = scanView([heard(cruxKilter)], homeWall).content;
    const atItsGym = scanView([heard(cruxKilter), heard(cruxTension)], homeWall);
    expect(summarize(stabilizePickerTop(drawn, atItsGym))).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-tension] (scanning)',
    );
    const atBloc = scanView([heard(blocKilter), heard(blocTension), heard(cruxKilter)], homeWall);
    expect(summarize(stabilizePickerTop(drawn, atBloc))).toBe('hero:crux-kilter~nearby (scanning)');
  });

  it('keeps a hero with no gym a hero', () => {
    const drawn = scanView([heard(homeWall), heard(friendsWall)], null).content;
    expect(summarize({ ...scanView([], null), content: drawn })).toBe('hero:home-wall (scanning)');
    const next = scanView([heard(homeWall), heard(friendsWall), heard(cruxKilter), heard(cruxTension)], null);
    expect(summarize(stabilizePickerTop(drawn, next))).toBe('hero:home-wall (scanning)');
  });

  it('says "In front of you" for the hero it holds from what is heard now', () => {
    const drawnNearby = scanView([MOONBOARD_ROW, heard(cruxKilter)], homeWall).content;
    const nowLoudest = scanView([heard(cruxKilter), heard(blocKilter), heard(blocTension)], homeWall);
    expect(summarize(stabilizePickerTop(drawnNearby, nowLoudest))).toBe('hero:crux-kilter (scanning)');
    const drawnLoudest = scanView([heard(cruxKilter)], homeWall).content;
    const nowQuieter = scanView([heard(blocKilter), heard(blocTension), heard(cruxKilter)], homeWall);
    expect(summarize(stabilizePickerTop(drawnLoudest, nowQuieter))).toBe('hero:crux-kilter~nearby (scanning)');
  });

  it('follows the hero it drew, so its "Nearby" can change', () => {
    const drawn = scanView([heard(cruxKilter)], homeWall).content;
    const next = scanView([MOONBOARD_ROW, heard(cruxKilter)], homeWall);
    expect(summarize(stabilizePickerTop(drawn, next))).toBe('hero:crux-kilter~nearby (scanning)');
  });

  it('keeps At {gym} when a later box would make it a hero or another gym', () => {
    const drawn = scanView([heard(cruxKilter), heard(cruxTension)], homeWall).content;
    const toBloc = scanView(
      [heard(blocKilter, -30), heard(blocTension, -35), heard(cruxKilter), heard(cruxTension)],
      homeWall,
    );
    expect(summarize(stabilizePickerTop(drawn, toBloc))).toBe('at_gym:Crux/scan[crux-kilter,crux-tension] (scanning)');
    const toHero = scanView([heard(blocKilter)], homeWall);
    expect(summarize(toHero)).toBe('hero:bloc-kilter (scanning)');
    expect(summarize(stabilizePickerTop(drawn, toHero))).toBe('at_gym:Crux/scan[crux-kilter,crux-tension] (scanning)');
  });

  // The roster landing, or another wall heard: they join the end, nothing moves.
  it('keeps the rows in the order drawn and adds late walls at the end', () => {
    const drawn = scanView([heard(cruxTension), heard(cruxMoon)], homeWall).content;
    const withRoster = scanView([heard(cruxTension), heard(cruxMoon)], homeWall, [
      cruxKilter,
      board('crux-arch', CRUX),
    ]);
    expect(summarize(withRoster)).toBe('at_gym:Crux/scan[crux-arch,crux-kilter,crux-moon,crux-tension] (scanning)');
    expect(summarize(stabilizePickerTop(drawn, withRoster))).toBe(
      'at_gym:Crux/scan[crux-moon,crux-tension,crux-arch,crux-kilter] (scanning)',
    );
  });

  it('tells a moved top from an unmoved one by its signature', () => {
    const drawn = scanView([heard(cruxTension), heard(cruxMoon)], homeWall);
    const withRoster = scanView([heard(cruxTension), heard(cruxMoon)], homeWall, [cruxKilter]);
    expect(pickerTopSignature(stabilizePickerTop(drawn.content, withRoster).content)).toBe(
      'at_gym:gym-crux:crux-moon,crux-tension,crux-kilter',
    );
    expect(pickerTopSignature(scanView([heard(cruxKilter)], homeWall).content)).toBe('hero:crux-kilter');
  });
});

// The decision behind a top already drawn: its roster query, its walls heard.
describe('decisionAtDrawnTop', () => {
  const decide = (rows: readonly QuickstartRow[], activeBoard: UserBoard | null = homeWall) =>
    decidePickerTop({ phase: 'scanning', rows, lookup: 'resolved', activeBoard });
  const drawnFrom = (rows: readonly QuickstartRow[], activeBoard: UserBoard | null = homeWall) =>
    buildPickerTopView(decide(rows, activeBoard), []).content;

  it('leaves the decision alone before the scan has led', () => {
    const decision = decide([heard(cruxKilter)]);
    expect(decisionAtDrawnTop(decision, null)).toBe(decision);
  });

  it('keeps At {gym} on the gym drawn, its roster and every wall heard there', () => {
    const drawn = drawnFrom([heard(cruxKilter), heard(cruxTension)]);
    const decision = decide([heard(blocKilter), heard(blocTension), heard(board('bloc-moon', BLOC)), heard(cruxMoon)]);
    expect(pickerTopGymUuid(decision)).toBe('gym-bloc');
    const kept = decisionAtDrawnTop(decision, drawn);
    expect(pickerTopGymUuid(kept)).toBe('gym-crux');
    expect(summarize(buildPickerTopView(kept, [board('crux-arch', CRUX)]))).toBe(
      'at_gym:Crux/scan[crux-arch,crux-kilter,crux-moon,crux-tension] (scanning)',
    );
    const view = buildPickerTopView(kept, [board('crux-arch', CRUX)]);
    expect(view.content.kind === 'at_gym' ? [...view.content.heardKeys].sort() : []).toEqual([
      'crux-kilter',
      'crux-moon',
      'crux-tension',
    ]);
  });

  it("makes a hero its own gym's at two walls heard there, however many another gym has", () => {
    const drawn = drawnFrom([heard(cruxKilter)]);
    const oneAtCrux = decide([
      heard(cruxKilter),
      heard(blocKilter),
      heard(blocTension),
      heard(board('bloc-moon', BLOC)),
    ]);
    expect(pickerTopGymUuid(decisionAtDrawnTop(oneAtCrux, drawn))).toBeNull();
    expect(summarize(buildPickerTopView(decisionAtDrawnTop(oneAtCrux, drawn), []))).toBe('hero:crux-kilter (scanning)');

    const twoAtCrux = decide([
      heard(blocKilter),
      heard(blocTension),
      heard(board('bloc-moon', BLOC)),
      heard(cruxKilter),
      heard(cruxTension),
    ]);
    expect(pickerTopGymUuid(twoAtCrux)).toBe('gym-bloc');
    const upgraded = decisionAtDrawnTop(twoAtCrux, drawn);
    expect(pickerTopGymUuid(upgraded)).toBe('gym-crux');
    expect(summarize(buildPickerTopView(upgraded, [cruxMoon]))).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-moon,crux-tension] (scanning)',
    );
  });

  it('keeps a hero with no gym a hero, fetching no roster', () => {
    const drawn = drawnFrom([heard(homeWall), heard(friendsWall)], null);
    const decision = decide([heard(homeWall), heard(friendsWall), heard(cruxKilter), heard(cruxTension)], null);
    expect(pickerTopGymUuid(decision)).toBe('gym-crux');
    expect(pickerTopGymUuid(decisionAtDrawnTop(decision, drawn))).toBeNull();
  });
});

describe('what the rest of the picker leaves out', () => {
  it('names every board the top lists, but no hidden board without a uuid', () => {
    const geometryOnly = board('', null, { serialNumber: 'S9' });
    const uuidsOf = (inputs: Partial<PickerTopInputs>, roster?: readonly UserBoard[]) => [
      ...pickerTopBoardUuids(
        pickerTopView({ phase: 'done', rows: [], lookup: 'resolved', activeBoard: null, ...inputs }, roster),
      ),
    ];
    expect(uuidsOf({ rows: [heard(geometryOnly)] })).toEqual([]);
    expect(uuidsOf({ activeBoard: cruxKilter }, [cruxTension])).toEqual(['crux-kilter', 'crux-tension']);
    expect(uuidsOf({ rows: [heard(cruxKilter)], activeBoard: homeWall })).toEqual(['crux-kilter']);
    expect(uuidsOf({ activeBoard: homeWall })).toEqual([]);
  });
});

describe('how a pick from the top is reported', () => {
  it('says bluetooth for a gym the scan found, with each row in its place', () => {
    const view = pickerTopView({
      phase: 'done',
      rows: [heard(cruxTension), heard(cruxKilter)],
      lookup: 'resolved',
      activeBoard: null,
    });
    const picks = pickerTopPicks(view);
    expect(picks.get('crux-kilter')).toEqual({
      board: cruxKilter,
      pickSource: 'bluetooth',
      section: 'at_gym',
      position: 0,
    });
    expect(picks.get('crux-tension')).toMatchObject({ pickSource: 'bluetooth', section: 'at_gym', position: 1 });
  });

  it('says gym_walls for a gym that came from the board you are on', () => {
    const view = pickerTopView({ phase: 'tap_to_scan', rows: [], lookup: 'none', activeBoard: cruxMoon }, [cruxKilter]);
    expect(pickerTopPicks(view).get('crux-kilter')).toEqual({
      board: cruxKilter,
      pickSource: 'gym_walls',
      section: 'at_gym',
      position: 0,
    });
  });

  it('says bluetooth for the hero, first in its section', () => {
    const view = pickerTopView({ phase: 'done', rows: [heard(cruxKilter)], lookup: 'resolved', activeBoard: homeWall });
    expect(pickerTopPicks(view).get('crux-kilter')).toEqual({
      board: cruxKilter,
      pickSource: 'bluetooth',
      section: 'hero',
      position: 0,
    });
  });

  it('offers nothing to pick when the top lists no board', () => {
    const view = pickerTopView({ phase: 'done', rows: [MOONBOARD_ROW], lookup: 'none', activeBoard: null });
    expect(pickerTopPicks(view).size).toBe(0);
  });
});

describe('mapPickerTopBoards', () => {
  it('swaps the boards for what the view draws, keeping the rest', () => {
    const view = pickerTopView({ phase: 'scanning', rows: [], lookup: 'none', activeBoard: cruxKilter }, [cruxTension]);
    const mapped = mapPickerTopBoards(view, (boards, kind) => boards.map((row) => `${kind}:${row.key}`));
    expect(mapped).toEqual({
      ...view,
      content: { ...view.content, rows: ['at_gym:crux-kilter', 'at_gym:crux-tension'] },
    });
  });

  it('keeps the hero its label, and drops a hero the view cannot draw', () => {
    const view = pickerTopView({
      phase: 'done',
      rows: [MOONBOARD_ROW, heard(cruxKilter)],
      lookup: 'resolved',
      activeBoard: null,
    });
    expect(mapPickerTopBoards(view, (boards) => boards.map((row) => row.key)).content).toEqual({
      kind: 'hero',
      board: 'crux-kilter',
      strongestSignal: false,
    });
    expect(mapPickerTopBoards(view, () => []).content).toEqual({ kind: 'none' });
  });
});

describe('collapsedRows', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const only =
    (...kept: string[]) =>
    (row: string) =>
      kept.includes(row);

  it('never collapses to hide a single row', () => {
    expect(collapsedRows(rows.slice(0, 5), only('e'), 4)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('shows the first rows of a long list', () => {
    expect(collapsedRows(rows, only('b'), 4)).toEqual(['a', 'b', 'c', 'd']);
    expect(collapsedRows(rows, only(), 4)).toEqual(['a', 'b', 'c', 'd']);
  });

  // The board you're on, which no other list shows, can't hide behind Show all.
  it('keeps a row that must show, in its place, and gives up room for it', () => {
    expect(collapsedRows(rows, only('g'), 4)).toEqual(['a', 'b', 'c', 'g']);
  });

  // The walls the scan heard stay in view too.
  it('keeps every row that must show', () => {
    expect(collapsedRows(rows, only('b', 'f', 'h'), 4)).toEqual(['a', 'b', 'f', 'h']);
    expect(collapsedRows(rows, only('e', 'f', 'g', 'h'), 4)).toEqual(['e', 'f', 'g', 'h']);
  });

  it('shows everything when keeping the rows that must show would hide one row at most', () => {
    expect(collapsedRows(rows, only('b', 'c', 'd', 'e', 'f', 'g', 'h'), 4)).toEqual(rows);
  });
});
