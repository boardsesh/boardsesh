import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  buildPickerTopView,
  collapsedAtGymRows,
  decidePickerTop,
  gymMostHeard,
  mapPickerTopBoards,
  pickerTopBoardUuids,
  pickerTopGymUuid,
  pickerTopPicks,
  pickerTopView,
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
};
const LOOKUP_FAILED_ROW: QuickstartRow = { kind: 'lookup_failed', key: 'lookup_failed', rssi: -40 };

const cruxKilter = board('crux-kilter', CRUX);
const cruxTension = board('crux-tension', CRUX);
const cruxMoon = board('crux-moon', CRUX);
const blocKilter = board('bloc-kilter', BLOC);
const blocTension = board('bloc-tension', BLOC);
const homeWall = board('home-wall');
const friendsWall = board('friends-wall');

/** The top in one line: the notice, what leads (with its gym, source and rows) and the spinner. */
function summarize(view: PickerTopView<PickerTopBoard>): string {
  const { notice, content, scanning } = view;
  let lead: string;
  switch (content.kind) {
    case 'at_gym':
      lead = `at_gym:${content.gymName}/${content.source}[${content.rows
        .map((row) => `${row.board.uuid}${row.selected ? '*' : ''}`)
        .join(',')}]`;
      break;
    case 'hero':
      lead = `hero:${content.board.board.uuid}`;
      break;
    case 'unnamed':
      lead = `unnamed:${content.row.key}`;
      break;
    default:
      lead = content.kind;
  }
  const noticeText =
    notice === null
      ? ''
      : `${notice.kind}${notice.kind === 'lookup_failed' && notice.besideHeardBoards ? '(beside)' : ''} + `;
  return `${noticeText}${lead}${scanning ? ' (scanning)' : ''}`;
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

  it('falls back to it as well when the named boards heard have no gym', () => {
    expect(top({ rows: [heard(homeWall), heard(friendsWall)], activeBoard: cruxKilter })).toBe(
      'at_gym:Crux/active_board[crux-kilter*]',
    );
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

describe('boxes it cannot name', () => {
  it.each([MOONBOARD_ROW, BARE_KILTER_ROW, UNKNOWN_SETUP_ROW])('leads with $kind when no gym is known', (row) => {
    expect(top({ rows: [row] })).toBe(`unnamed:${row.key}`);
    expect(top({ rows: [row], activeBoard: homeWall })).toBe(`unnamed:${row.key}`);
  });

  it('takes the strongest of several', () => {
    expect(top({ rows: [UNKNOWN_SETUP_ROW, MOONBOARD_ROW] })).toBe('unnamed:unknown_setup:tension');
  });

  it('is ignored once the board you are on names a gym', () => {
    expect(top({ rows: [MOONBOARD_ROW], activeBoard: cruxKilter })).toBe('at_gym:Crux/active_board[crux-kilter*]');
  });

  it('is ignored beside a named board', () => {
    expect(top({ rows: [MOONBOARD_ROW, heard(cruxKilter)], activeBoard: homeWall })).toBe('hero:crux-kilter');
    expect(top({ rows: [MOONBOARD_ROW, heard(cruxKilter), heard(cruxTension)] })).toBe(
      'at_gym:Crux/scan[crux-kilter,crux-tension]',
    );
    // Even one that names no gym: it is the board you're on, right there.
    expect(top({ rows: [MOONBOARD_ROW, heard(homeWall)], activeBoard: homeWall })).toBe('none');
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
    expect(top({ phase, rows: [heard(cruxKilter)] })).toBe(expected);
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

  it('holds the placeholder while scanning with no gym known', () => {
    expect(top({ phase: 'scanning', lookup: 'none' })).toBe('looking (scanning)');
    expect(top({ phase: 'scanning', lookup: 'none', activeBoard: homeWall })).toBe('looking (scanning)');
  });

  it('lists the gym of the board you are on while scanning, with the spinner', () => {
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
    expect(top({ phase: 'scanning', lookup: 'none', rows: [MOONBOARD_ROW] })).toBe(
      'unnamed:moonboard:moonboard (scanning)',
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
    expect(top({ rows: [LOOKUP_FAILED_ROW, heard(cruxKilter)], lookup: 'failed', activeBoard: homeWall })).toBe(
      'lookup_failed(beside) + hero:crux-kilter',
    );
    expect(top({ rows: [heard(cruxKilter), LOOKUP_FAILED_ROW, heard(cruxTension)], lookup: 'failed' })).toBe(
      'lookup_failed(beside) + at_gym:Crux/scan[crux-kilter,crux-tension]',
    );
  });

  it('keeps the box it cannot name beside the card', () => {
    expect(top({ rows: [LOOKUP_FAILED_ROW, MOONBOARD_ROW], lookup: 'failed' })).toBe(
      'lookup_failed + unnamed:moonboard:moonboard',
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

describe('what the rest of the picker leaves out', () => {
  it('names every board the top lists, but no hidden board without a uuid', () => {
    const geometryOnly = board('', null, { serialNumber: 'S9' });
    expect([
      ...pickerTopBoardUuids(
        pickerTopView({ phase: 'done', rows: [heard(geometryOnly)], lookup: 'resolved', activeBoard: null }),
      ),
    ]).toEqual([]);
    expect([
      ...pickerTopBoardUuids(
        pickerTopView({ phase: 'done', rows: [], lookup: 'none', activeBoard: cruxKilter }, [cruxTension]),
      ),
    ]).toEqual(['crux-kilter', 'crux-tension']);
    expect([
      ...pickerTopBoardUuids(
        pickerTopView({ phase: 'done', rows: [heard(cruxKilter)], lookup: 'resolved', activeBoard: homeWall }),
      ),
    ]).toEqual(['crux-kilter']);
    expect(
      pickerTopBoardUuids(pickerTopView({ phase: 'done', rows: [], lookup: 'none', activeBoard: homeWall })).size,
    ).toBe(0);
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
    expect(
      pickerTopPicks(pickerTopView({ phase: 'done', rows: [MOONBOARD_ROW], lookup: 'none', activeBoard: null })).size,
    ).toBe(0);
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

  it('drops a hero the view cannot draw', () => {
    const view = pickerTopView({ phase: 'done', rows: [heard(cruxKilter)], lookup: 'resolved', activeBoard: null });
    expect(mapPickerTopBoards(view, () => []).content).toEqual({ kind: 'none' });
  });
});

describe('collapsedAtGymRows', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const selected = (target: string) => (row: string) => row === target;

  it('never collapses to hide a single row', () => {
    expect(collapsedAtGymRows(rows.slice(0, 5), selected('e'))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('shows the first four of a long gym', () => {
    expect(collapsedAtGymRows(rows, selected('b'))).toEqual(['a', 'b', 'c', 'd']);
    expect(collapsedAtGymRows(rows, () => false)).toEqual(['a', 'b', 'c', 'd']);
  });

  // Your boards no longer lists the board you're on: it can't hide behind Show all.
  it('keeps the selected row in place of the last one shown', () => {
    expect(collapsedAtGymRows(rows, selected('g'))).toEqual(['a', 'b', 'c', 'g']);
  });
});
