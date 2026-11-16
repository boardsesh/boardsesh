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

/** The content's kind plus whichever row or rows it carries, by key. */
function summarize(content: InRangeContent<InRangeBoardRow>): string {
  switch (content.kind) {
    case 'hero':
      return `hero:${content.board.key}`;
    case 'board_rows':
      return `board_rows:${content.boards.map((row) => row.key).join(',')}@${content.gymName ?? '-'}`;
    case 'unnamed':
      return `unnamed:${content.row.key}`;
    default:
      return content.kind;
  }
}

describe('inRangeView', () => {
  it.each<{ phase: PickerScanPhase; rows: QuickstartRow[]; expected: string; scanning: boolean }>([
    // Phases that ignore rows.
    { phase: 'hidden', rows: [], expected: 'none', scanning: false },
    { phase: 'needs_permission', rows: [], expected: 'permission_card', scanning: false },
    { phase: 'blocked_denied', rows: [], expected: 'blocked_denied', scanning: false },
    { phase: 'blocked_off', rows: [], expected: 'blocked_off', scanning: false },
    { phase: 'tap_to_scan', rows: [], expected: 'tap_to_scan', scanning: false },
    { phase: 'tap_to_scan', rows: [boardRow('crux-kilter')], expected: 'tap_to_scan', scanning: false },
    // Scanning: rows show as they come in, the spinner stays.
    { phase: 'scanning', rows: [], expected: 'looking', scanning: true },
    { phase: 'scanning', rows: [boardRow('crux-kilter')], expected: 'hero:board:crux-kilter', scanning: true },
    { phase: 'scanning', rows: [MOONBOARD_ROW], expected: 'unnamed:moonboard:moonboard', scanning: true },
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
    // A board it can name wins over a closer box it can't.
    {
      phase: 'done',
      rows: [UNKNOWN_SETUP_ROW, boardRow('crux-kilter', CRUX), MOONBOARD_ROW],
      expected: 'hero:board:crux-kilter',
      scanning: false,
    },
    // Nothing it can name: the closest thing heard decides.
    { phase: 'done', rows: [MOONBOARD_ROW, BARE_KILTER_ROW], expected: 'unnamed:moonboard:moonboard', scanning: false },
    { phase: 'done', rows: [BARE_KILTER_ROW], expected: 'unnamed:bare_name:kilter', scanning: false },
    { phase: 'done', rows: [UNKNOWN_SETUP_ROW], expected: 'unnamed:unknown_setup:tension', scanning: false },
    { phase: 'done', rows: [LOOKUP_FAILED_ROW, MOONBOARD_ROW], expected: 'lookup_failed', scanning: false },
    {
      phase: 'done',
      rows: [MOONBOARD_ROW, LOOKUP_FAILED_ROW],
      expected: 'unnamed:moonboard:moonboard',
      scanning: false,
    },
  ])('$phase with $rows.length rows → $expected', ({ phase, rows, expected, scanning }) => {
    const view = inRangeView(phase, rows);
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
  const heroAtCrux = inRangeView('done', [boardRow('crux-kilter', CRUX)]).content;

  it.each<{
    name: string;
    content: InRangeContent<InRangeBoardRow>;
    active: UserBoard | null;
    expected: string | null;
  }>([
    { name: 'the board in range', content: heroAtCrux, active: activeAtBloc, expected: 'crux-kilter' },
    {
      name: 'the board in range has no gym: nothing, not the active board',
      content: inRangeView('done', [boardRow('home-kilter')]).content,
      active: activeAtBloc,
      expected: null,
    },
    {
      name: 'several boards in range: their rows already are the gym',
      content: inRangeView('done', [boardRow('crux-kilter', CRUX), boardRow('crux-moon', CRUX)]).content,
      active: activeAtBloc,
      expected: null,
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

  it('maps the hero and the rows, and leaves every other kind alone', () => {
    expect(mapInRangeBoards(inRangeView('done', [boardRow('crux')]).content, toTitles)).toEqual({
      kind: 'hero',
      board: 'CRUX',
    });
    expect(mapInRangeBoards(inRangeView('done', [boardRow('a', CRUX), boardRow('b', CRUX)]).content, toTitles)).toEqual(
      {
        kind: 'board_rows',
        boards: ['A', 'B'],
        gymName: 'Crux',
      },
    );
    const unnamed = inRangeView('done', [MOONBOARD_ROW]).content;
    expect(mapInRangeBoards(unnamed, toTitles)).toBe(unnamed);
  });

  it('reads as nothing in range when the hero board cannot be drawn', () => {
    expect(mapInRangeBoards(inRangeView('done', [boardRow('crux')]).content, () => [])).toEqual({
      kind: 'none_in_range',
    });
  });
});
