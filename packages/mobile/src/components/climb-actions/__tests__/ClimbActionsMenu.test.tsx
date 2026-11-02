// @vitest-environment jsdom
import React, { createElement, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbActionsTarget } from '../../../providers/drawer-host-provider';

const runtime = vi.hoisted(() => ({
  generation: 0,
  executed: vi.fn(),
  commands: vi.fn(),
  openPlaylist: vi.fn(),
  board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
  queue: [] as { uuid: string }[],
  current: null as { uuid: string } | null,
  nowSlotMode: false,
  activeClimbUuid: null as string | null,
  renders: [] as string[],
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: {
    actions: { label: string; disabled?: boolean }[];
    children?: ReactNode;
    onSelectIndex: (index: number) => void;
  }) =>
    createElement(
      'div',
      { 'data-app-menu': true },
      props.children,
      props.actions.map((action, index) =>
        createElement(
          'button',
          { key: action.label, disabled: action.disabled, onClick: () => props.onSelectIndex(index) },
          action.label,
        ),
      ),
    ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    actionColors: { success: 'green', favorite: 'pink', accent: 'purple' },
  }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useClimbModerationEnabled: () => true }));
vi.mock('../../../lib/spray/use-spray-wall-archive', () => ({ useSprayWallIsArchived: () => false }));
vi.mock('../../../hooks/use-is-climb-favorited', () => ({ useIsClimbFavorited: () => false }));
vi.mock('../../../hooks/use-privacy-scoped-state', () => ({ usePrivacyScopedState: useState }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => runtime.generation }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  boardConfigsMatch: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  useDrawerHost: () => ({ boardConfig: runtime.board, openAddToPlaylist: runtime.openPlaylist }),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useActiveClimbUuid: () => runtime.activeClimbUuid,
  useQueueData: () => ({
    queue: runtime.queue,
    currentClimbQueueItem: runtime.current,
    nowSlotMode: runtime.nowSlotMode,
  }),
}));
vi.mock('../use-climb-actions', () => ({
  useClimbActions: (args: { climb: Climb; onAfterAction?: () => void }) => {
    runtime.commands(args);
    return ['playNext', 'tick'].map((id) => ({
      id,
      run: () => {
        runtime.executed(id, args.climb.uuid);
        args.onAfterAction?.();
      },
    }));
  },
}));

import { ClimbMenu, ClimbMenusProvider, useClimbMenu } from '../ClimbActionsMenu';

function target(uuid: string, extra: Partial<ClimbActionsTarget> = {}): ClimbActionsTarget {
  return { climb: { uuid, name: uuid, userId: 'setter' } as Climb, boardConfig: runtime.board, ...extra };
}
function Row({ selected }: { selected: ClimbActionsTarget }) {
  const menu = useClimbMenu(selected);
  return <ClimbMenu rows={menu.rows} menuKey={menu.menuKey} />;
}
function Harness({ selected }: { selected: ClimbActionsTarget }) {
  return (
    <ClimbMenusProvider currentUserId="viewer" isAuthenticated>
      <Row selected={selected} />
    </ClimbMenusProvider>
  );
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  runtime.generation = 0;
  runtime.queue = [];
  runtime.current = null;
  runtime.nowSlotMode = false;
  runtime.activeClimbUuid = null;
  runtime.renders = [];
  vi.clearAllMocks();
});

// A memoised row, as every list row is: it re-renders only for its own props or
// for what it reads from the menu runtime.
const CountedRow = React.memo(function CountedRow({ selected }: { selected: ClimbActionsTarget }) {
  runtime.renders.push(selected.climb.uuid);
  const menu = useClimbMenu(selected);
  return <ClimbMenu rows={menu.rows} menuKey={menu.menuKey} />;
});
function CountedRows({ rows }: { rows: ClimbActionsTarget[] }) {
  return (
    <ClimbMenusProvider currentUserId="viewer" isAuthenticated activeBoardConfig={runtime.board}>
      {rows.map((row) => (
        <CountedRow key={row.climb.uuid} selected={row} />
      ))}
    </ClimbMenusProvider>
  );
}
afterEach(cleanup);

describe('ClimbMenu anchor', () => {
  const oneRow = [{ id: 'tick' as const, label: 'Log', run: () => undefined }];
  let mounts = 0;
  function Body() {
    const [mountId] = useState(() => {
      mounts += 1;
      return mounts;
    });
    return <span data-mount={mountId}>Row body</span>;
  }

  it('keeps a row anchored when its rows drop to none, so the row is not remounted', () => {
    const { container, rerender } = render(
      <ClimbMenu rows={oneRow} menuKey="a">
        <Body />
      </ClimbMenu>,
    );
    const mount = container.querySelector('[data-mount]')?.getAttribute('data-mount');
    rerender(
      <ClimbMenu rows={[]} menuKey="edit">
        <Body />
      </ClimbMenu>,
    );
    expect(container.querySelector('[data-app-menu]')).not.toBeNull();
    rerender(
      <ClimbMenu rows={oneRow} menuKey="a">
        <Body />
      </ClimbMenu>,
    );
    expect(container.querySelector('[data-mount]')?.getAttribute('data-mount')).toBe(mount);
  });

  it('adds no anchor to a row that never had a menu', () => {
    const { container } = render(
      <ClimbMenu rows={[]} menuKey="none">
        <Body />
      </ClimbMenu>,
    );
    expect(container.querySelector('[data-app-menu]')).toBeNull();
    expect(container.textContent).toBe('Row body');
  });
});

describe('shared native climb menu commands', () => {
  it('renders metadata without mounting command hooks or resolving climbs', () => {
    const resolveClimb = vi.fn();
    render(<Harness selected={target('a', { resolveClimb })} />);
    expect(screen.getByText('mobile.climbActions.playNext')).toBeTruthy();
    expect(screen.getByText('mobile.climbActions.tick')).toBeTruthy();
    expect(runtime.commands).not.toHaveBeenCalled();
    expect(resolveClimb).not.toHaveBeenCalled();
  });

  it('runs one selected command against its captured climb', async () => {
    render(<Harness selected={target('a')} />);
    fireEvent.click(screen.getByText('mobile.climbActions.playNext'));
    await waitFor(() => expect(runtime.executed).toHaveBeenCalledExactlyOnceWith('playNext', 'a'));
  });

  it('ignores an older hydration after selecting another climb', async () => {
    const first = deferred<Climb | null>();
    const view = render(<Harness selected={target('a', { resolveClimb: () => first.promise })} />);
    fireEvent.click(screen.getByText('mobile.climbActions.playNext'));
    view.rerender(<Harness selected={target('b')} />);
    fireEvent.click(screen.getByText('mobile.climbActions.playNext'));
    await waitFor(() => expect(runtime.executed).toHaveBeenCalledExactlyOnceWith('playNext', 'b'));
    await act(async () => first.resolve(target('a').climb));
    expect(runtime.executed).toHaveBeenCalledTimes(1);
  });

  it('refuses a hydration that finishes after credentials change', async () => {
    const pending = deferred<Climb | null>();
    render(<Harness selected={target('a', { resolveClimb: () => pending.promise })} />);
    fireEvent.click(screen.getByText('mobile.climbActions.playNext'));
    runtime.generation += 1;
    await act(async () => pending.resolve(target('a').climb));
    expect(runtime.executed).not.toHaveBeenCalled();
  });

  it('leaves every row alone when a queue update changes nothing it shows', () => {
    const rows = [target('a'), target('b')];
    const view = render(<CountedRows rows={rows} />);
    expect(runtime.renders).toEqual(['a', 'b']);
    // A crewmate adds a climb: a new queue array, no row's state moved.
    runtime.queue = [{ uuid: 'slot-new' }];
    view.rerender(<CountedRows rows={rows} />);
    expect(runtime.renders).toEqual(['a', 'b']);
  });

  it('re-renders only the row whose climb went on the wall', () => {
    const rows = [target('a'), target('b')];
    const view = render(<CountedRows rows={rows} />);
    runtime.renders = [];
    runtime.activeClimbUuid = 'a';
    view.rerender(<CountedRows rows={rows} />);
    expect(runtime.renders).toEqual(['a']);
    // On the wall already, so its menu drops Play next; the other keeps it.
    expect(screen.getAllByText('mobile.climbActions.playNext')).toHaveLength(1);
  });

  it('offers Replay from here on a History row only while now-slot mode is on', () => {
    // The mode flips without touching the queue or the current climb.
    runtime.queue = [{ uuid: 'history-1' }, { uuid: 'now' }];
    runtime.current = runtime.queue[1];
    runtime.nowSlotMode = true;
    const history = target('a', { queueItemUuid: 'history-1' });
    const { rerender } = render(<Harness selected={history} />);
    expect(screen.queryByText('mobile.climbActions.replayFromHere')).not.toBeNull();
    runtime.nowSlotMode = false;
    rerender(<Harness selected={history} />);
    expect(screen.queryByText('mobile.climbActions.replayFromHere')).toBeNull();
    runtime.nowSlotMode = true;
    rerender(<Harness selected={history} />);
    expect(screen.queryByText('mobile.climbActions.replayFromHere')).not.toBeNull();
  });

  it('includes board, angle, queue slot, and credentials in native menu identity', () => {
    function Identity({ selected }: { selected: ClimbActionsTarget }) {
      return <output>{useClimbMenu(selected).menuKey}</output>;
    }
    const view = render(
      <ClimbMenusProvider currentUserId="viewer" isAuthenticated>
        <Identity selected={target('a', { queueItemUuid: 'slot-a' })} />
      </ClimbMenusProvider>,
    );
    const previous = screen.getByRole('status').textContent;
    runtime.generation += 1;
    view.rerender(
      <ClimbMenusProvider currentUserId="viewer" isAuthenticated>
        <Identity selected={target('a', { boardConfig: { ...runtime.board, angle: 50 }, queueItemUuid: 'slot-b' })} />
      </ClimbMenusProvider>,
    );
    expect(screen.getByRole('status').textContent).not.toBe(previous);
    expect(screen.getByRole('status').textContent).toContain('slot-b');
  });
});
