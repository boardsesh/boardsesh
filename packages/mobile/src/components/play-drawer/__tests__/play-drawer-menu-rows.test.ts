import { describe, expect, it, vi } from 'vitest';
import type { ClimbActionId, ClimbActionItem } from '../../climb-actions/use-climb-actions';
import type { IconName } from '../../icon-map';
import {
  buildPlayDrawerMenuRows,
  resolveQueuedSlotUuid,
  type PlayDrawerMenuRowOptions,
} from '../play-drawer-menu-rows';

const ICONS: Record<ClimbActionId, IconName> = {
  preview: 'visibility',
  queue: 'add',
  openQueue: 'queue',
  playNext: 'queue.next',
  playlist: 'playlist',
  favorite: 'favorite',
  tick: 'tick',
  editEntry: 'edit',
  betaVideo: 'video',
  edit: 'edit',
  fork: 'branch',
  viewOptions: 'view.options',
  share: 'share',
  openInApp: 'open.external',
  report: 'flag',
  delete: 'delete',
};

/** What `useClimbActions` hands the player, in the hook's own order. */
const HOOK_ORDER: ClimbActionId[] = [
  'preview',
  'queue',
  'openQueue',
  'playNext',
  'playlist',
  'favorite',
  'tick',
  'editEntry',
  'betaVideo',
  'edit',
  'fork',
  'viewOptions',
  'share',
  'openInApp',
  'report',
  'delete',
];

function item(id: ClimbActionId): ClimbActionItem {
  return { id, title: `title:${id}`, icon: ICONS[id], color: '#000', run: vi.fn() };
}

const EVERY_ITEM = HOOK_ORDER.map(item);

const NOTHING_HIDDEN: PlayDrawerMenuRowOptions = {
  hidden: { favorite: false, share: false, queue: false },
  boardMismatch: false,
  isActiveClimb: false,
};
const EVERYTHING_HIDDEN: PlayDrawerMenuRowOptions = {
  ...NOTHING_HIDDEN,
  hidden: { favorite: true, share: true, queue: true },
};

const rowIds = (options: PlayDrawerMenuRowOptions, items = EVERY_ITEM) =>
  buildPlayDrawerMenuRows(items, options).map((row) => row.id);

describe('buildPlayDrawerMenuRows', () => {
  it('orders the rows in five groups and opens each group after the first with a divider', () => {
    const rows = buildPlayDrawerMenuRows(EVERY_ITEM, EVERYTHING_HIDDEN);

    expect(rows.map((row) => row.id)).toEqual([
      'playNext',
      'queue',
      'openQueue',
      'playlist',
      'favorite',
      'share',
      'betaVideo',
      'edit',
      'fork',
      'viewOptions',
      'openInApp',
      'report',
      'delete',
    ]);
    expect(rows.filter((row) => row.dividerBefore).map((row) => row.id)).toEqual([
      'playlist',
      'betaVideo',
      'viewOptions',
      'report',
    ]);
  });

  // Preview: already on that climb. Tick: the hero button is always there for a
  // member. Edit entry: a logbook-only row.
  it('never offers preview, tick or edit entry', () => {
    const ids = rowIds(EVERYTHING_HIDDEN);
    expect(ids).not.toContain('preview');
    expect(ids).not.toContain('tick');
    expect(ids).not.toContain('editEntry');
  });

  it('offers the queue, favourite and share only while the bar has put their button away', () => {
    const shown = rowIds(NOTHING_HIDDEN);
    expect(shown).not.toContain('openQueue');
    expect(shown).not.toContain('favorite');
    expect(shown).not.toContain('share');

    expect(rowIds({ ...NOTHING_HIDDEN, hidden: { favorite: true, share: false, queue: false } })).toContain('favorite');
    expect(rowIds({ ...NOTHING_HIDDEN, hidden: { favorite: false, share: true, queue: false } })).toContain('share');
    expect(rowIds({ ...NOTHING_HIDDEN, hidden: { favorite: false, share: false, queue: true } })).toContain(
      'openQueue',
    );
  });

  it('drops Play next on the climb that is already on the wall', () => {
    expect(rowIds({ ...NOTHING_HIDDEN, isActiveClimb: true })).not.toContain('playNext');
    expect(rowIds(NOTHING_HIDDEN)).toContain('playNext');
  });

  // The divider belongs to the first row a group actually has, so a group whose
  // leading rows are gone still opens with one, and an empty group adds none.
  it('moves a divider onto the first row a group still has', () => {
    const items = (['queue', 'playlist', 'fork', 'report'] as ClimbActionId[]).map(item);
    const rows = buildPlayDrawerMenuRows(items, NOTHING_HIDDEN);

    expect(rows.map((row) => [row.id, row.dividerBefore])).toEqual([
      ['queue', false],
      ['playlist', true],
      ['fork', true],
      ['report', true],
    ]);
  });

  it('never puts a divider above the first row', () => {
    const rows = buildPlayDrawerMenuRows([item('viewOptions'), item('report')], NOTHING_HIDDEN);
    expect(rows[0]).toMatchObject({ id: 'viewOptions', dividerBefore: false });
    expect(rows[1]).toMatchObject({ id: 'report', dividerBefore: true });
  });

  it('marks delete, and only delete, destructive', () => {
    const rows = buildPlayDrawerMenuRows(EVERY_ITEM, EVERYTHING_HIDDEN);
    expect(rows.filter((row) => row.destructive).map((row) => row.id)).toEqual(['delete']);
  });

  // The switch-board scrim is up: nothing that writes, but the climber can still
  // share the climb, open it in its own app, and change what the drawer shows.
  it('disables every row that writes while the climb belongs to another board', () => {
    const rows = buildPlayDrawerMenuRows(EVERY_ITEM, { ...EVERYTHING_HIDDEN, boardMismatch: true });

    expect(rows.filter((row) => !row.disabled).map((row) => row.id)).toEqual(['share', 'viewOptions', 'openInApp']);
    // Disabled, not removed: the indices after a disabled row must not shift.
    expect(rows).toHaveLength(13);
  });

  it('enables every row on the climber own board', () => {
    expect(buildPlayDrawerMenuRows(EVERY_ITEM, EVERYTHING_HIDDEN).some((row) => row.disabled)).toBe(false);
  });

  it('carries each item title, its SF Symbol and the action it runs', () => {
    const playlist = item('playlist');
    const [row] = buildPlayDrawerMenuRows([playlist], NOTHING_HIDDEN);

    expect(row).toMatchObject({ id: 'playlist', label: 'title:playlist', systemIcon: 'folder.badge.plus' });
    row?.run();
    expect(playlist.run).toHaveBeenCalledTimes(1);
  });
});

describe('resolveQueuedSlotUuid', () => {
  const queuedSlots = [{ uuid: 'slot-a' }, { uuid: 'slot-b' }];

  it('targets the displayed slot when it is queued, so Play next moves that copy', () => {
    expect(resolveQueuedSlotUuid(queuedSlots, 'slot-b')).toBe('slot-b');
  });

  it('leaves an unqueued preview to match by climb rather than insert a duplicate', () => {
    expect(resolveQueuedSlotUuid(queuedSlots, 'preview-item')).toBeUndefined();
  });

  it('has nothing to target with no displayed slot', () => {
    expect(resolveQueuedSlotUuid(queuedSlots, undefined)).toBeUndefined();
  });
});
