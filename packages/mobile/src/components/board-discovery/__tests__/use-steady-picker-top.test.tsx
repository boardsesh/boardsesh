// @vitest-environment jsdom
//
// Holding the top of the picker still while a scan runs: nothing the scan heard
// leads for its first 3 s, and what it led with stays for the rest of the scan.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { PickerScanPhase } from '../picker-scan-phase';
import { pickerTopView, type InRangeBoardRow, type PickerTopBoard, type PickerTopView } from '../picker-top-view';
import type { QuickstartRow } from '../quickstart-scan-rows';
import { PICKER_SCAN_HOLD_MS, usePickerScanHold, useSteadyPickerTop } from '../use-steady-picker-top';

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
const blocKilter = board('bloc-kilter', BLOC);
const blocTension = board('bloc-tension', BLOC);
const homeWall = board('home-wall', null);

function heard(target: UserBoard): InRangeBoardRow {
  return { kind: 'board', key: `board:${target.uuid}`, board: target, rssi: -50, recognizedBy: 'serial' };
}

function viewOf(
  phase: PickerScanPhase,
  rows: readonly QuickstartRow[],
  activeBoard: UserBoard | null,
): PickerTopView<PickerTopBoard> {
  return pickerTopView({ phase, rows, lookup: 'resolved', activeBoard });
}

function lead(view: PickerTopView<PickerTopBoard>): string {
  const { content } = view;
  if (content.kind === 'hero') return `hero:${content.board.key}`;
  if (content.kind === 'at_gym') return `at_gym:${content.gymName}[${content.rows.map((row) => row.key).join(',')}]`;
  return content.kind;
}

describe('usePickerScanHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds for the first seconds of each scan, and never when not scanning', () => {
    const { result, rerender } = renderHook(({ phase }: { phase: PickerScanPhase }) => usePickerScanHold(phase), {
      initialProps: { phase: 'tap_to_scan' as PickerScanPhase },
    });
    expect(result.current).toBe(false);

    rerender({ phase: 'scanning' });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(PICKER_SCAN_HOLD_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);

    rerender({ phase: 'done' });
    expect(result.current).toBe(false);
    // Scan again: it holds again.
    rerender({ phase: 'scanning' });
    expect(result.current).toBe(true);
  });

  it('lets go when the scan ends early', () => {
    const { result, rerender } = renderHook(({ phase }: { phase: PickerScanPhase }) => usePickerScanHold(phase), {
      initialProps: { phase: 'scanning' as PickerScanPhase },
    });
    expect(result.current).toBe(true);
    rerender({ phase: 'done' });
    expect(result.current).toBe(false);
  });
});

describe('useSteadyPickerTop', () => {
  function renderSteady(initial: { view: PickerTopView<PickerTopBoard>; phase: PickerScanPhase }) {
    return renderHook(
      ({ view, phase }: { view: PickerTopView<PickerTopBoard>; phase: PickerScanPhase }) =>
        useSteadyPickerTop(view, phase),
      { initialProps: initial },
    );
  }

  it('keeps the hero the scan led with for the rest of that scan, through its end', () => {
    const { result, rerender } = renderSteady({
      view: viewOf('scanning', [heard(cruxKilter)], homeWall),
      phase: 'scanning',
    });
    expect(lead(result.current)).toBe('hero:crux-kilter');

    rerender({ view: viewOf('scanning', [heard(cruxKilter), heard(cruxTension)], homeWall), phase: 'scanning' });
    expect(lead(result.current)).toBe('hero:crux-kilter');
    rerender({ view: viewOf('done', [heard(cruxKilter), heard(cruxTension)], homeWall), phase: 'done' });
    expect(lead(result.current)).toBe('hero:crux-kilter');
  });

  it('starts over with a new scan', () => {
    const { result, rerender } = renderSteady({
      view: viewOf('scanning', [heard(cruxKilter)], homeWall),
      phase: 'scanning',
    });
    rerender({ view: viewOf('done', [heard(cruxKilter)], homeWall), phase: 'done' });
    rerender({ view: viewOf('tap_to_scan', [], homeWall), phase: 'tap_to_scan' });
    rerender({ view: viewOf('scanning', [heard(cruxKilter), heard(cruxTension)], homeWall), phase: 'scanning' });
    expect(lead(result.current)).toBe('at_gym:Crux[crux-kilter,crux-tension]');
  });

  it('keeps one gym when the scan later hears more of another', () => {
    const { result, rerender } = renderSteady({
      view: viewOf('scanning', [heard(cruxKilter), heard(cruxTension)], homeWall),
      phase: 'scanning',
    });
    rerender({
      view: viewOf(
        'scanning',
        [heard(blocKilter), heard(blocTension), heard(board('bloc-moon', BLOC)), heard(cruxKilter)],
        homeWall,
      ),
      phase: 'scanning',
    });
    expect(lead(result.current)).toBe('at_gym:Crux[crux-kilter,crux-tension]');
  });

  // The gym of the board you're on, drawn while the scan holds, gives way to
  // what the scan finds: that is the one change the hold allows.
  it('lets the scan replace the gym of the board you are on once', () => {
    const { result, rerender } = renderSteady({
      view: viewOf('scanning', [], cruxKilter),
      phase: 'scanning',
    });
    expect(lead(result.current)).toBe('at_gym:Crux[crux-kilter]');
    rerender({ view: viewOf('scanning', [heard(blocKilter), heard(blocTension)], cruxKilter), phase: 'scanning' });
    expect(lead(result.current)).toBe('at_gym:Bloc[bloc-kilter,bloc-tension]');
    rerender({
      view: viewOf('scanning', [heard(cruxKilter), heard(cruxTension), heard(blocKilter)], cruxKilter),
      phase: 'scanning',
    });
    expect(lead(result.current)).toBe('at_gym:Bloc[bloc-kilter,bloc-tension]');
  });
});
