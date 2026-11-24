import { describe, expect, it } from 'vite-plus/test';
import type { BoardSetupChange } from '@boardsesh/shared-schema';
import {
  appendSetupChanges,
  boardReportsTabHref,
  canUndoSetupChange,
  readBoardReportsTab,
  setupChangeBoardHref,
  setupChangeGymHref,
  setupUndoOutcome,
} from '../board-setup-changes-logic';

function change(eventId: string, state: BoardSetupChange['state'] = 'LIVE'): BoardSetupChange {
  return {
    eventId,
    board: { uuid: 'board-1', name: 'Crux Kilter', slug: 'crux-kilter', boardType: 'kilter' },
    gym: { uuid: 'gym-1', name: 'Crux', slug: null },
    before: { layoutId: 1, sizeId: 7, setIds: '1', angle: null },
    after: { layoutId: 1, sizeId: 10, setIds: '1', angle: null },
    climberDisplayName: 'Ana',
    createdAt: '2026-11-24T10:00:00.000Z',
    state,
  };
}

describe('board setup changes', () => {
  it('lets only a live change be undone', () => {
    expect(canUndoSetupChange({ state: 'LIVE' })).toBe(true);
    expect(canUndoSetupChange({ state: 'UNDONE' })).toBe(false);
    expect(canUndoSetupChange({ state: 'CHANGED_SINCE' })).toBe(false);
  });

  it('reads an undo: done, already undone, changed since, or any other failure', () => {
    const refusal = (code: string) => ({ response: { errors: [{ message: 'x', extensions: { code } }] } });
    expect(setupUndoOutcome({ ok: true })).toBe('undone');
    expect(setupUndoOutcome({ ok: false, error: refusal('BOARD_SETUP_ALREADY_UNDONE') })).toBe('already_undone');
    expect(setupUndoOutcome({ ok: false, error: refusal('BOARD_SETUP_CHANGED_SINCE') })).toBe('changed_since');
    expect(setupUndoOutcome({ ok: false, error: refusal('FORBIDDEN') })).toBe('failed');
    expect(setupUndoOutcome({ ok: false, error: new Error('network') })).toBe('failed');
  });

  it('appends a page without repeating a change already listed', () => {
    expect(
      appendSetupChanges([change('a'), change('b')], [change('b'), change('c')]).map((row) => row.eventId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('opens the setup changes only from ?tab=setup-changes', () => {
    expect(readBoardReportsTab('setup-changes')).toBe('setup-changes');
    expect(readBoardReportsTab('reports')).toBe('reports');
    expect(readBoardReportsTab(undefined)).toBe('reports');
    expect(readBoardReportsTab(['setup-changes'])).toBe('reports');
  });

  it('writes the tab to the URL, dropping it for the report queue and keeping other parameters', () => {
    expect(boardReportsTabHref('/admin/board-reports', '', 'setup-changes')).toBe(
      '/admin/board-reports?tab=setup-changes',
    );
    expect(boardReportsTabHref('/admin/board-reports', 'tab=setup-changes', 'reports')).toBe('/admin/board-reports');
    expect(boardReportsTabHref('/admin/board-reports', 'report=abc&tab=reports', 'setup-changes')).toBe(
      '/admin/board-reports?report=abc&tab=setup-changes',
    );
    expect(boardReportsTabHref('/admin/board-reports', 'report=abc&tab=setup-changes', 'reports')).toBe(
      '/admin/board-reports?report=abc',
    );
  });

  it('links the board by slug and the gym by slug, or uuid without one', () => {
    expect(setupChangeBoardHref(change('a').board)).toBe('/b/crux-kilter');
    expect(setupChangeGymHref({ uuid: 'gym-1', name: 'Crux', slug: null })).toBe('/gym/gym-1');
    expect(setupChangeGymHref({ uuid: 'gym-1', name: 'Crux', slug: 'crux' })).toBe('/gym/crux');
  });
});
