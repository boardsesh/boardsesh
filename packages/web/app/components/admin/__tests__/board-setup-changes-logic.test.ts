import { describe, expect, it } from 'vite-plus/test';
import type { BoardSetupChange } from '@boardsesh/shared-schema';
import {
  appendSetupChanges,
  canUndoSetupChange,
  setupChangeBoardHref,
  setupChangeGymHref,
  stateAfterUndo,
  withChangeState,
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

  it('reads an undo: done, changed since, or any other failure', () => {
    expect(stateAfterUndo({ ok: true })).toBe('UNDONE');
    const changedSince = {
      response: { errors: [{ message: 'x', extensions: { code: 'BOARD_SETUP_CHANGED_SINCE' } }] },
    };
    expect(stateAfterUndo({ ok: false, error: changedSince })).toBe('CHANGED_SINCE');
    expect(stateAfterUndo({ ok: false, error: new Error('network') })).toBeNull();
  });

  it('updates one row and keeps the rest', () => {
    const rows = withChangeState([change('a'), change('b')], 'b', 'UNDONE');
    expect(rows.map((row) => row.state)).toEqual(['LIVE', 'UNDONE']);
  });

  it('appends a page without repeating a change already listed', () => {
    expect(
      appendSetupChanges([change('a'), change('b')], [change('b'), change('c')]).map((row) => row.eventId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('links the board by slug and the gym by slug, or uuid without one', () => {
    expect(setupChangeBoardHref(change('a').board)).toBe('/b/crux-kilter');
    expect(setupChangeGymHref({ uuid: 'gym-1', name: 'Crux', slug: null })).toBe('/gym/gym-1');
    expect(setupChangeGymHref({ uuid: 'gym-1', name: 'Crux', slug: 'crux' })).toBe('/gym/crux');
  });
});
