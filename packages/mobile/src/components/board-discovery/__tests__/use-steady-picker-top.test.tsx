// @vitest-environment jsdom
//
// Holding the top of the picker still while a scan runs: nothing the scan heard
// leads for 3 s after it first hears anything, or while the lookup is still
// naming what it heard, and once it has led it stays until the results leave
// the screen, with one way out for a hero: its own gym.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { PickerScanPhase } from '../picker-scan-phase';
import {
  buildPickerTopView,
  decidePickerTop,
  decisionAtDrawnTop,
  pickerTopGymUuid,
  stabilizePickerTop,
  type InRangeBoardRow,
  type PickerTopBoard,
  type PickerTopView,
} from '../picker-top-view';
import type { QuickstartLookupState, QuickstartRow } from '../quickstart-scan-rows';
import {
  PICKER_SCAN_HOLD_MS,
  scanHeardAnything,
  usePickerScanHold,
  usePickerTopSteadiness,
} from '../use-steady-picker-top';

function board(uuid: string, gym: { uuid: string; name: string } | null): UserBoard {
  return {
    uuid,
    name: uuid,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    gymUuid: gym?.uuid ?? null,
    gymName: gym?.name ?? null,
  } as unknown as UserBoard;
}
const CRUX = { uuid: 'gym-crux', name: 'Crux' };
const BLOC = { uuid: 'gym-bloc', name: 'Bloc' };
const cruxKilter = board('crux-kilter', CRUX);
const cruxTension = board('crux-tension', CRUX);
const cruxMoon = board('crux-moon', CRUX);
const blocKilter = board('bloc-kilter', BLOC);
const blocTension = board('bloc-tension', BLOC);
const blocMoon = board('bloc-moon', BLOC);
const homeWall = board('home-wall', null);

function heard(target: UserBoard): InRangeBoardRow {
  return { kind: 'board', key: `board:${target.uuid}`, board: target, rssi: -50, recognizedBy: 'serial' };
}

function lead(view: PickerTopView<PickerTopBoard>): string {
  const { content } = view;
  if (content.kind === 'hero') return `hero:${content.board.key}${content.strongestSignal ? '' : '~nearby'}`;
  if (content.kind === 'at_gym') return `at_gym:${content.gymName}[${content.rows.map((row) => row.key).join(',')}]`;
  return content.kind;
}

function listen(ms = PICKER_SCAN_HOLD_MS) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('scanHeardAnything', () => {
  it('counts a row, or a serial whose first lookup is still out', () => {
    expect(scanHeardAnything([], 'none')).toBe(false);
    expect(scanHeardAnything([], 'pending')).toBe(true);
    expect(scanHeardAnything([heard(cruxKilter)], 'resolved')).toBe(true);
  });
});

describe('usePickerScanHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type HoldProps = { phase: PickerScanPhase; heardAnything: boolean };
  function renderHold(initialProps: HoldProps) {
    return renderHook(({ phase, heardAnything }: HoldProps) => usePickerScanHold(phase, heardAnything), {
      initialProps,
    });
  }

  // `scanning` also covers the permission prompt and a start held for the radio.
  it('counts its seconds from the first thing heard, not from the phase', () => {
    const { result, rerender } = renderHold({ phase: 'scanning', heardAnything: false });
    expect(result.current).toBe(true);
    listen(10_000);
    expect(result.current).toBe(true);

    rerender({ phase: 'scanning', heardAnything: true });
    listen(PICKER_SCAN_HOLD_MS - 1);
    expect(result.current).toBe(true);
    listen(1);
    expect(result.current).toBe(false);
  });

  it('holds again for each new scan, and never when not scanning', () => {
    const { result, rerender } = renderHold({ phase: 'tap_to_scan', heardAnything: false });
    expect(result.current).toBe(false);

    rerender({ phase: 'scanning', heardAnything: true });
    expect(result.current).toBe(true);
    listen();
    expect(result.current).toBe(false);

    rerender({ phase: 'done', heardAnything: true });
    expect(result.current).toBe(false);
    rerender({ phase: 'scanning', heardAnything: true });
    expect(result.current).toBe(true);
    listen();
    expect(result.current).toBe(false);
  });

  it('lets go when the scan ends early', () => {
    const { result, rerender } = renderHold({ phase: 'scanning', heardAnything: true });
    expect(result.current).toBe(true);
    rerender({ phase: 'done', heardAnything: true });
    expect(result.current).toBe(false);
  });
});

// The picker's own wiring (app/boards/index.tsx), with each gym's roster as the
// query would answer it.
type ScanProps = {
  phase: PickerScanPhase;
  rows: readonly QuickstartRow[];
  lookup: QuickstartLookupState;
  activeBoard: UserBoard | null;
};
const ROSTERS: Record<string, readonly UserBoard[]> = { [CRUX.uuid]: [cruxMoon], [BLOC.uuid]: [blocMoon] };

function usePickerTop({ phase, rows, lookup, activeBoard }: ScanProps) {
  const steadiness = usePickerTopSteadiness(phase, lookup);
  const scanHold = usePickerScanHold(phase, scanHeardAnything(rows, lookup));
  const holdScanLead = scanHold || steadiness.waitsOnLookup;
  const decision = decisionAtDrawnTop(
    decidePickerTop({ phase, rows, lookup, activeBoard, holdScanLead }),
    steadiness.drawn,
  );
  const rosterGym = pickerTopGymUuid(decision);
  const view = stabilizePickerTop(steadiness.drawn, buildPickerTopView(decision, rosterGym ? ROSTERS[rosterGym] : []));
  steadiness.record(view);
  return { top: lead(view), rosterGym };
}

describe('the top while one scan runs', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function renderScan(initialProps: ScanProps) {
    return renderHook((props: ScanProps) => usePickerTop(props), { initialProps });
  }
  const scanning = (rows: readonly QuickstartRow[], lookup: QuickstartLookupState = 'resolved'): ScanProps => ({
    phase: 'scanning',
    rows,
    lookup,
    activeBoard: homeWall,
  });

  // The review's case: three walls at Crux, the first one named a second
  // before the other two. Two named walls at a gym are At {gym}.
  it('draws nothing it heard while the lookup is still naming boxes, then the gym they make', () => {
    const { result, rerender } = renderScan(scanning([heard(cruxKilter)], 'updating'));
    listen();
    expect(result.current.top).toBe('none');

    rerender(scanning([heard(cruxKilter), heard(cruxTension), heard(cruxMoon)]));
    expect(result.current.top).toBe('at_gym:Crux[crux-kilter,crux-moon,crux-tension]');
  });

  it('lets a hero become its own gym once a second wall there is named', () => {
    const { result, rerender } = renderScan(scanning([heard(cruxKilter)]));
    expect(result.current.top).toBe('none');
    listen();
    expect(result.current.top).toBe('hero:crux-kilter');

    rerender(scanning([heard(cruxKilter)], 'updating'));
    expect(result.current.top).toBe('hero:crux-kilter');
    rerender(scanning([heard(cruxKilter), heard(cruxTension)]));
    expect(result.current).toEqual({ top: 'at_gym:Crux[crux-kilter,crux-moon,crux-tension]', rosterGym: CRUX.uuid });
    // And never back to a hero.
    rerender(scanning([heard(cruxKilter)]));
    expect(result.current.top).toBe('at_gym:Crux[crux-kilter,crux-moon,crux-tension]');
  });

  it('never moves a hero to another gym, and fetches no other gym behind it', () => {
    const { result, rerender } = renderScan(scanning([heard(cruxKilter)]));
    listen();
    rerender(scanning([heard(cruxKilter), heard(blocKilter), heard(blocTension), heard(blocMoon)]));
    expect(result.current).toEqual({ top: 'hero:crux-kilter', rosterGym: null });

    // Its own gym still wins with two walls to Bloc's three.
    rerender(scanning([heard(cruxKilter), heard(blocKilter), heard(blocTension), heard(blocMoon), heard(cruxTension)]));
    expect(result.current).toEqual({ top: 'at_gym:Crux[crux-kilter,crux-moon,crux-tension]', rosterGym: CRUX.uuid });
  });

  it('says "In front of you" for a held hero only while it is the loudest heard', () => {
    const { result, rerender } = renderScan(scanning([heard(cruxKilter)]));
    listen();
    expect(result.current.top).toBe('hero:crux-kilter');

    rerender(scanning([heard(blocKilter), heard(blocTension), heard(cruxKilter)]));
    expect(result.current.top).toBe('hero:crux-kilter~nearby');
    rerender(scanning([heard(cruxKilter), heard(blocKilter), heard(blocTension)]));
    expect(result.current.top).toBe('hero:crux-kilter');
  });

  it('keeps one gym, and its roster, when the scan later hears more of another', () => {
    const { result, rerender } = renderScan(scanning([heard(cruxKilter), heard(cruxTension)]));
    listen();
    expect(result.current.top).toBe('at_gym:Crux[crux-kilter,crux-moon,crux-tension]');

    rerender(scanning([heard(blocKilter), heard(blocTension), heard(blocMoon), heard(cruxKilter)]));
    expect(result.current).toEqual({ top: 'at_gym:Crux[crux-kilter,crux-moon,crux-tension]', rosterGym: CRUX.uuid });
  });

  it('keeps the hero through the end of the scan', () => {
    const { result, rerender } = renderScan(scanning([heard(cruxKilter)]));
    listen();
    rerender(scanning([heard(cruxKilter), heard(blocKilter), heard(blocTension)]));
    rerender({ ...scanning([heard(cruxKilter), heard(blocKilter), heard(blocTension)]), phase: 'done' });
    expect(result.current.top).toBe('hero:crux-kilter');
  });

  // Linking to a board hides the slot; what the scan led with is not the top
  // any more, even when the same results come back.
  it('lets go of what it held once the results leave the screen', () => {
    const rows = [heard(cruxKilter), heard(blocKilter), heard(blocTension)];
    const { result, rerender } = renderScan(scanning([heard(cruxKilter)]));
    listen();
    rerender({ ...scanning(rows), phase: 'done' });
    expect(result.current.top).toBe('hero:crux-kilter');

    rerender({ phase: 'hidden', rows, lookup: 'resolved', activeBoard: blocKilter });
    expect(result.current.top).toBe('at_gym:Bloc[bloc-kilter,bloc-moon]');
    rerender({ phase: 'done', rows, lookup: 'resolved', activeBoard: homeWall });
    expect(result.current.top).toBe('at_gym:Bloc[bloc-kilter,bloc-moon,bloc-tension]');
  });

  it('starts over with a new scan', () => {
    const { result, rerender } = renderScan(scanning([heard(cruxKilter)]));
    listen();
    rerender({ ...scanning([heard(cruxKilter)]), phase: 'done' });
    rerender({ ...scanning([]), phase: 'tap_to_scan' });
    rerender(scanning([heard(cruxKilter), heard(cruxTension)]));
    listen();
    expect(result.current.top).toBe('at_gym:Crux[crux-kilter,crux-moon,crux-tension]');
  });

  // The gym of the board you're on, drawn while the scan holds, gives way to
  // what the scan finds: that is the one change the hold allows.
  it('lets the scan replace the gym of the board you are on once', () => {
    const onCrux = (rows: readonly QuickstartRow[]): ScanProps => ({ ...scanning(rows), activeBoard: cruxKilter });
    const { result, rerender } = renderScan(onCrux([heard(blocKilter), heard(blocTension)]));
    expect(result.current.top).toBe('at_gym:Crux[crux-kilter,crux-moon]');
    listen();
    expect(result.current.top).toBe('at_gym:Bloc[bloc-kilter,bloc-moon,bloc-tension]');
    rerender(onCrux([heard(cruxKilter), heard(cruxTension), heard(blocKilter), heard(blocTension)]));
    expect(result.current.top).toBe('at_gym:Bloc[bloc-kilter,bloc-moon,bloc-tension]');
  });
});
