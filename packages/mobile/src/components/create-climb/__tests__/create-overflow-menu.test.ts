import { describe, it, expect } from 'vitest';
import { buildCreateOverflowMenu, type CreateOverflowMenuState } from '../create-overflow-menu';

// The overflow menu is the ONLY way into and out of route mode, so "which rows
// exist in which state" is behaviour rather than presentation. It is also the
// only place a frame can be deleted now, and the rows are addressed by index —
// a state that drops a row must not shift a tap onto a neighbouring action.

const translate = (key: string, params?: Record<string, number | string>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

const state = (overrides: Partial<CreateOverflowMenuState> = {}): CreateOverflowMenuState => ({
  supportsMultiFrame: true,
  routeMode: false,
  frameCount: 1,
  frameIndex: 0,
  ...overrides,
});

const actionsOf = (input: CreateOverflowMenuState) =>
  buildCreateOverflowMenu(input, translate).map((row) => row.action);

describe('buildCreateOverflowMenu', () => {
  it('offers route mode on a boulder', () => {
    expect(actionsOf(state())).toEqual(['makeRoute', 'newClimb']);
  });

  it('offers the way back out while a route is still one frame', () => {
    const rows = buildCreateOverflowMenu(state({ routeMode: true }), translate);
    expect(rows.map((row) => row.action)).toEqual(['makeBoulder', 'newClimb']);
    expect(rows[0].disabled).toBeFalsy();
    expect(rows[0].label).toBe('mobile.create.routeMenu.makeBoulder');
  });

  it('blocks the way out above one frame rather than hiding it', () => {
    // Frames are absolute snapshots: keeping frame 1 would discard every hold
    // painted after the start position, and flattening would rewrite the climb
    // silently. Deleting frames is the explicit, undoable path — so the row
    // stays visible and says so, because a missing row reads as a missing
    // feature and leaves the setter stuck in route mode with no explanation.
    const rows = buildCreateOverflowMenu(state({ routeMode: true, frameCount: 4 }), translate);
    const makeBoulder = rows.find((row) => row.action === 'makeBoulder');
    expect(makeBoulder?.disabled).toBe(true);
    expect(makeBoulder?.label).toBe('mobile.create.routeMenu.makeBoulderBlocked');
  });

  it('names the frame that Delete would remove', () => {
    // "Delete frame" beside a strip of four makes you guess which one it means.
    const rows = buildCreateOverflowMenu(state({ routeMode: true, frameCount: 4, frameIndex: 2 }), translate);
    const deleteFrame = rows.find((row) => row.action === 'deleteFrame');
    expect(deleteFrame?.label).toBe('mobile.create.routeMenu.deleteFrame:{"index":3}');
    expect(deleteFrame?.destructive).toBe(true);
  });

  it('offers no frame to delete while a route is still one frame', () => {
    expect(actionsOf(state({ routeMode: true }))).not.toContain('deleteFrame');
  });

  it('treats a multi-frame climb as a route even without the flag', () => {
    // An edit or a fork opens on frames that already exist; the controller seeds
    // the flag from them, but the menu must not depend on that having happened.
    expect(actionsOf(state({ routeMode: false, frameCount: 3 }))).toEqual(['deleteFrame', 'makeBoulder', 'newClimb']);
  });

  it('offers no route rows at all on a single-frame board', () => {
    // Woods: its packet builder rejects the comma a second frame introduces, so
    // offering the mode would offer a climb that cannot reach the wall.
    expect(actionsOf(state({ supportsMultiFrame: false }))).toEqual(['newClimb']);
    expect(actionsOf(state({ supportsMultiFrame: false, routeMode: true, frameCount: 3 }))).toEqual(['newClimb']);
  });

  it('keeps every row addressable by its own index in every state', () => {
    const everyState: CreateOverflowMenuState[] = [
      state(),
      state({ routeMode: true }),
      state({ routeMode: true, frameCount: 4, frameIndex: 3 }),
      state({ supportsMultiFrame: false }),
    ];
    for (const input of everyState) {
      const rows = buildCreateOverflowMenu(input, translate);
      expect(rows.length).toBeGreaterThan(0);
      // Uniqueness is what makes index-to-action mapping safe in the header.
      expect(new Set(rows.map((row) => row.action)).size).toBe(rows.length);
      expect(rows.every((row) => row.label.length > 0)).toBe(true);
    }
  });
});
