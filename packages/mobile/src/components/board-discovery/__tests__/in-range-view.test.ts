import { describe, expect, it } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  alsoAtGymAnchor,
  inRangeView,
  mapInRangeBoards,
  sharedGymName,
  type InRangeBoardRow,
  type InRangeContent,
} from '../in-range-view';
import type { PickerScanPhase } from '../picker-scan-phase';
import type { QuickstartRow } from '../quickstart-scan-rows';

function board(uuid: string, gym: { uuid: string; name: string } | null = null): UserBoard {
  return {
    uuid,
    name: uuid,
    boardType: 'kilter',
    gymUuid: gym?.uuid ?? null,
    gymName: gym?.name ?? null,
  } as unknown as UserBoard;
}

const CRUX = { uuid: 'gym-crux', name: 'Crux' };
const BLOC = { uuid: 'gym-bloc', name: 'Bloc' };

function boardRow(uuid: string, gym: { uuid: string; name: string } | null = null): InRangeBoardRow {
  return { kind: 'board', key: `board:${uuid}`, board: board(uuid, gym), rssi: -50, recognizedBy: 'serial' };
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

/** The content's kind plus whichever rows it carries, by key, and what else is in range. */
function summarize(content: InRangeContent<InRangeBoardRow>): string {
  const keys = (boards: readonly InRangeBoardRow[]) => boards.map((row) => row.key).join(',');
  const also = (alsoInRange: { kind: string; row?: { key: string } } | null) =>
    alsoInRange === null ? '' : ` +${alsoInRange.row?.key ?? alsoInRange.kind}`;
  switch (content.kind) {
    case 'hero':
      return `hero:${content.board.key}${also(content.also)}`;
    case 'board_rows':
      return `board_rows:${keys(content.boards)}@${content.gymName ?? '-'}${also(content.also)}`;
    case 'unnamed':
      return `unnamed:${content.row.key}[${keys(content.boards)}]`;
    case 'lookup_failed':
      return `lookup_failed[${keys(content.boards)}]`;
    default:
      return content.kind;
  }
}

describe('inRangeView', () => {
  it.each<{
    phase: PickerScanPhase;
    rows: QuickstartRow[];
    lookupPending?: boolean;
    expected: string;
    scanning: boolean;
  }>([
    // Phases that ignore rows.
    { phase: 'hidden', rows: [], expected: 'none', scanning: false },
    { phase: 'needs_permission', rows: [], expected: 'permission_card', scanning: false },
    { phase: 'blocked_denied', rows: [], expected: 'blocked_denied', scanning: false },
    { phase: 'blocked_off', rows: [], expected: 'blocked_off', scanning: false },
    { phase: 'unreachable', rows: [], expected: 'unreachable', scanning: false },
    { phase: 'tap_to_scan', rows: [], expected: 'tap_to_scan', scanning: false },
    { phase: 'tap_to_scan', rows: [boardRow('crux-kilter')], expected: 'tap_to_scan', scanning: false },
    // Scanning: rows show as they come in, the spinner stays.
    { phase: 'scanning', rows: [], expected: 'looking', scanning: true },
    { phase: 'scanning', rows: [boardRow('crux-kilter')], expected: 'hero:board:crux-kilter', scanning: true },
    { phase: 'scanning', rows: [MOONBOARD_ROW], expected: 'unnamed:moonboard:moonboard[]', scanning: true },
    // While the serial lookup is out the serial rows are held back, so what
    // shows now could be overtaken: the slot holds its place instead.
    { phase: 'scanning', rows: [MOONBOARD_ROW], lookupPending: true, expected: 'looking', scanning: true },
    { phase: 'scanning', rows: [boardRow('home')], lookupPending: true, expected: 'looking', scanning: true },
    // Done: a pre-empted or finished scan with nothing heard reads the same, with Scan again.
    { phase: 'done', rows: [], expected: 'none_in_range', scanning: false },
    { phase: 'done', rows: [boardRow('crux-kilter', CRUX)], expected: 'hero:board:crux-kilter', scanning: false },
    {
      phase: 'done',
      rows: [boardRow('crux-kilter', CRUX), boardRow('crux-tension', CRUX), boardRow('crux-moon', CRUX)],
      expected: 'board_rows:board:crux-kilter,board:crux-tension,board:crux-moon@Crux',
      scanning: false,
    },
    {
      phase: 'done',
      rows: [boardRow('crux-kilter', CRUX), boardRow('bloc-kilter', BLOC)],
      expected: 'board_rows:board:crux-kilter,board:bloc-kilter@-',
      scanning: false,
    },
    // The strongest row leads, named or not. A MoonBoard beside a saved Kilter
    // is not the Kilter: the MoonBoard's card leads and the Kilter follows.
    {
      phase: 'done',
      rows: [MOONBOARD_ROW, boardRow('crux-kilter', CRUX)],
      expected: 'unnamed:moonboard:moonboard[board:crux-kilter]',
      scanning: false,
    },
    {
      phase: 'done',
      rows: [UNKNOWN_SETUP_ROW, boardRow('crux-kilter', CRUX), MOONBOARD_ROW, boardRow('crux-moon', CRUX)],
      expected: 'unnamed:unknown_setup:tension[board:crux-kilter,board:crux-moon]',
      scanning: false,
    },
    // A named lead with a box it can't name behind it: one compact row under it.
    {
      phase: 'done',
      rows: [boardRow('crux-kilter', CRUX), MOONBOARD_ROW],
      expected: 'hero:board:crux-kilter +moonboard:moonboard',
      scanning: false,
    },
    {
      phase: 'done',
      rows: [boardRow('crux-kilter', CRUX), BARE_KILTER_ROW, MOONBOARD_ROW],
      expected: 'hero:board:crux-kilter +bare_name:kilter',
      scanning: false,
    },
    {
      phase: 'done',
      rows: [boardRow('crux-kilter', CRUX), MOONBOARD_ROW, boardRow('crux-tension', CRUX)],
      expected: 'board_rows:board:crux-kilter,board:crux-tension@Crux +moonboard:moonboard',
      scanning: false,
    },
    {
      phase: 'done',
      rows: [boardRow('home'), LOOKUP_FAILED_ROW],
      expected: 'hero:board:home +lookup_failed',
      scanning: false,
    },
    // Nothing it can name: the closest thing heard decides.
    {
      phase: 'done',
      rows: [MOONBOARD_ROW, BARE_KILTER_ROW],
      expected: 'unnamed:moonboard:moonboard[]',
      scanning: false,
    },
    { phase: 'done', rows: [BARE_KILTER_ROW], expected: 'unnamed:bare_name:kilter[]', scanning: false },
    { phase: 'done', rows: [UNKNOWN_SETUP_ROW], expected: 'unnamed:unknown_setup:tension[]', scanning: false },
    { phase: 'done', rows: [LOOKUP_FAILED_ROW, MOONBOARD_ROW], expected: 'lookup_failed[]', scanning: false },
    {
      phase: 'done',
      rows: [LOOKUP_FAILED_ROW, boardRow('home')],
      expected: 'lookup_failed[board:home]',
      scanning: false,
    },
    {
      phase: 'done',
      rows: [MOONBOARD_ROW, LOOKUP_FAILED_ROW],
      expected: 'unnamed:moonboard:moonboard[]',
      scanning: false,
    },
  ])('$phase with $rows.length rows → $expected', ({ phase, rows, lookupPending = false, expected, scanning }) => {
    const view = inRangeView(phase, rows, { lookupPending });
    expect(summarize(view.content)).toBe(expected);
    expect(view.scanning).toBe(scanning);
  });
});

describe('sharedGymName', () => {
  it.each([
    { name: 'all at one gym', boards: [board('a', CRUX), board('b', CRUX)], expected: 'Crux' },
    { name: 'two gyms', boards: [board('a', CRUX), board('b', BLOC)], expected: null },
    { name: 'one with no gym', boards: [board('a', CRUX), board('b')], expected: null },
    { name: 'none with a gym', boards: [board('a'), board('b')], expected: null },
    { name: 'no boards', boards: [], expected: null },
  ])('$name → $expected', ({ boards, expected }) => {
    expect(sharedGymName(boards)).toBe(expected);
  });
});

describe('alsoAtGymAnchor', () => {
  const activeAtBloc = board('bloc-kilter', BLOC);
  const done = (rows: QuickstartRow[]) => inRangeView('done', rows, { lookupPending: false }).content;

  it.each<{
    name: string;
    content: InRangeContent<InRangeBoardRow>;
    active: UserBoard | null;
    expected: string | null;
  }>([
    {
      name: 'the board in range',
      content: done([boardRow('crux-kilter', CRUX)]),
      active: activeAtBloc,
      expected: 'crux-kilter',
    },
    {
      name: 'the board in range has no gym: nothing, not the active board',
      content: done([boardRow('home-kilter')]),
      active: activeAtBloc,
      expected: null,
    },
    {
      name: 'several boards in range: their rows already are the gym',
      content: done([boardRow('crux-kilter', CRUX), boardRow('crux-moon', CRUX)]),
      active: activeAtBloc,
      expected: null,
    },
    {
      name: 'an unnamed lead with named boards behind it: their rows are the walls around',
      content: done([MOONBOARD_ROW, boardRow('crux-kilter', CRUX)]),
      active: activeAtBloc,
      expected: null,
    },
    {
      name: 'an unnamed lead alone: the active board',
      content: done([MOONBOARD_ROW]),
      active: activeAtBloc,
      expected: 'bloc-kilter',
    },
    {
      name: 'nothing in range: the active board',
      content: { kind: 'none_in_range' },
      active: activeAtBloc,
      expected: 'bloc-kilter',
    },
    {
      name: 'still looking: the active board',
      content: { kind: 'looking' },
      active: activeAtBloc,
      expected: 'bloc-kilter',
    },
    { name: 'an active board with no gym', content: { kind: 'none' }, active: board('home'), expected: null },
    { name: 'no active board', content: { kind: 'none' }, active: null, expected: null },
  ])('$name', ({ content, active, expected }) => {
    expect(alsoAtGymAnchor(content, active)?.uuid ?? null).toBe(expected);
  });
});

describe('mapInRangeBoards', () => {
  const toTitles = (rows: readonly InRangeBoardRow[]) => rows.map((row) => row.board.name.toUpperCase());
  const done = (rows: QuickstartRow[]) => inRangeView('done', rows, { lookupPending: false }).content;

  it('maps every board the content carries, and keeps what else is in range', () => {
    expect(mapInRangeBoards(done([boardRow('crux'), MOONBOARD_ROW]), toTitles)).toEqual({
      kind: 'hero',
      board: 'CRUX',
      also: { kind: 'unnamed', row: MOONBOARD_ROW },
    });
    expect(mapInRangeBoards(done([boardRow('a', CRUX), boardRow('b', CRUX)]), toTitles)).toEqual({
      kind: 'board_rows',
      boards: ['A', 'B'],
      gymName: 'Crux',
      also: null,
    });
    expect(mapInRangeBoards(done([MOONBOARD_ROW, boardRow('a')]), toTitles)).toEqual({
      kind: 'unnamed',
      row: MOONBOARD_ROW,
      boards: ['A'],
    });
    expect(mapInRangeBoards(done([LOOKUP_FAILED_ROW, boardRow('a')]), toTitles)).toEqual({
      kind: 'lookup_failed',
      boards: ['A'],
    });
    const blocked = { kind: 'blocked_off' } as const;
    expect(mapInRangeBoards(blocked, toTitles)).toBe(blocked);
  });

  it('reads as nothing in range when the hero board cannot be drawn', () => {
    expect(mapInRangeBoards(done([boardRow('crux')]), () => [])).toEqual({ kind: 'none_in_range' });
  });
});
