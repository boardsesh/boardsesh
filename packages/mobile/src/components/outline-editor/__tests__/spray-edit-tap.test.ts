import { describe, expect, it } from 'vitest';
import { resolveEditTap, type SprayEditTapResult, type SprayEditorTool } from '../spray-edit-tap';

type Row = [label: string, tool: SprayEditorTool, hitId: number | null, selectedId: number | null, SprayEditTapResult];

describe('resolveEditTap', () => {
  // Rest mode, one row per line of the interaction table: an unselected ring
  // (ON, OFF or maybe — the role does not change the answer), the selected
  // ring, and bare wall with and without a selection.
  it.each<Row>([
    ['an unselected ring, nothing selected', 'edit', 4, null, 'select'],
    ['an unselected ring, another selected', 'edit', 4, 7, 'select'],
    ['a local (negative-id) ring', 'edit', -3, null, 'select'],
    ['the selected ring', 'edit', 7, 7, 'toggle'],
    ['the selected local ring', 'edit', -3, -3, 'toggle'],
    ['bare wall with a selection', 'edit', null, 7, 'deselect'],
    ['bare wall with nothing selected', 'edit', null, null, 'bareWallHint'],
  ])('rest: %s', (_label, tool, hitId, selectedId, expected) => {
    expect(resolveEditTap({ tool, hitId, selectedId })).toBe(expected);
  });

  it.each<Row>([
    ['a second ring', 'join', 4, 7, 'merge'],
    ['the hold being joined', 'join', 7, 7, 'none'],
    ['bare wall', 'join', null, 7, 'none'],
    ['a ring with nothing selected', 'join', 4, null, 'none'],
  ])('join: %s', (_label, tool, hitId, selectedId, expected) => {
    expect(resolveEditTap({ tool, hitId, selectedId })).toBe(expected);
  });

  it.each<Row>([
    ['trace on a ring', 'trace', 4, 7, 'none'],
    ['trace on bare wall', 'trace', null, 7, 'none'],
    ['add on a ring', 'add', 4, null, 'none'],
    ['add on bare wall', 'add', null, null, 'none'],
  ])('other tools ignore stray taps: %s', (_label, tool, hitId, selectedId, expected) => {
    expect(resolveEditTap({ tool, hitId, selectedId })).toBe(expected);
  });

  it('a double tap on a ring is select then toggle', () => {
    const first = resolveEditTap({ tool: 'edit', hitId: 4, selectedId: null });
    expect(first).toBe('select');
    // The screen selects on the first, so the second sees it selected.
    expect(resolveEditTap({ tool: 'edit', hitId: 4, selectedId: 4 })).toBe('toggle');
  });

  it('never answers a bare-wall tap with anything that adds a hold', () => {
    const answers = (['edit', 'join', 'trace', 'add'] as const).flatMap((tool) =>
      [null, 7].map((selectedId) => resolveEditTap({ tool, hitId: null, selectedId })),
    );
    expect(answers.every((answer) => answer !== 'select' && answer !== 'toggle' && answer !== 'merge')).toBe(true);
  });
});
