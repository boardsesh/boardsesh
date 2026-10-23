// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Fragment, createElement, type ReactElement, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutBlockSpec, WorkoutRun } from '@boardsesh/playlist-generator';
import type { GeneratorSelection } from '../../pre-session/workout-blocks';

const queue = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  queued: [] as Array<{ uuid: string; climb: { uuid: string } }>,
  appendQueueItems: vi.fn((items: unknown[]) => items.length),
}));
// The session id is read like the real context, so ending the session re-renders the sheet.
const sessionListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('../../../../providers/queue-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
  };
  return {
    useQueueSessionId: () => ({ sessionId: useSyncExternalStore(subscribe, () => queue.sessionId) }),
    useQueueActions: () => ({
      appendQueueItems: queue.appendQueueItems,
      getQueueSnapshot: () => ({ queue: queue.queued, currentClimbQueueItem: null, playlistSuggestionSource: null }),
    }),
  };
});

type PreviewArgs = {
  selection: GeneratorSelection;
  board: unknown;
  options: { isAuthenticated: boolean; getAvoidedClimbUuids?: () => ReadonlySet<string> };
};
const preview = vi.hoisted(() => ({
  calls: [] as PreviewArgs[],
  status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
  items: [] as Array<{ item: ClimbQueueItem; slot: { grade: number; index: number; section: string } }>,
  refreshingUuids: new Set<string>(),
  refreshSlot: vi.fn(),
  plannedCount: 0,
  staged: { items: [] as ClimbQueueItem[], run: null as WorkoutRun | null },
}));
vi.mock('../../pre-session/use-workout-preview', () => ({
  useWorkoutPreview: (selection: PreviewArgs['selection'], board: unknown, options: PreviewArgs['options']) => {
    preview.calls.push({ selection, board, options });
    const on = selection.blocks.length > 0;
    return {
      status: on ? preview.status : 'idle',
      items: on ? preview.items : [],
      refreshingUuids: preview.refreshingUuids,
      plannedCount: on ? preview.plannedCount : 0,
      plannedSlots: [],
      plannedStages: [],
      regenerate: vi.fn(),
      shuffle: vi.fn(),
      refreshSlot: preview.refreshSlot,
      toStagedQueueItems: () => preview.staged,
    };
  },
}));

const sheet = vi.hoisted(() => ({
  modal: null as null | { visible: boolean; onFullyDismissed?: () => void },
  topBar: null as null | { trailing: { onPress: () => void; disabled?: boolean }; error?: string | null },
}));
vi.mock('../../../ModalSheet', () => ({
  ModalSheet: (props: {
    visible: boolean;
    header?: ReactNode;
    children?: ReactNode;
    onFullyDismissed?: () => void;
  }) => {
    sheet.modal = props;
    // The native sheet keeps its content mounted through the slide-down.
    return createElement('div', null, props.header, props.children);
  },
}));
vi.mock('../../../SheetTopBar', () => ({
  SheetTopBar: (props: {
    title: string;
    trailing: { onPress: () => void; disabled?: boolean };
    error?: string | null;
  }) => {
    sheet.topBar = props;
    return createElement('header', null, props.title, props.error ? ` error:${props.error}` : '');
  },
}));

const fields = vi.hoisted(() => ({
  block: null as WorkoutBlockSpec | null,
  blockTypes: undefined as readonly string[] | undefined,
}));
vi.mock('../../pre-session/WorkoutBlockFields', () => ({
  WorkoutBlockFields: ({ block, blockTypes }: { block: WorkoutBlockSpec; blockTypes?: readonly string[] }) => {
    fields.block = block;
    fields.blockTypes = blockTypes;
    return createElement('div', null, block.kind === 'workout' ? `block:${block.options.type}` : 'block:warmUp');
  },
}));
vi.mock('../../pre-session/WorkoutPreviewSummary', () => ({
  WorkoutPreviewSummary: ({ shuffleDisabled }: { shuffleDisabled: boolean }) => {
    summary.shuffleDisabled = shuffleDisabled;
    return createElement('div', null, 'summary');
  },
}));
// The sheet's list renders every row it is given, header first, like a short
// FlatList does on device.
type MockListProps = {
  testID?: string;
  data: readonly unknown[];
  renderItem: (info: { item: unknown; index: number }) => ReactElement | null;
  keyExtractor: (row: unknown) => string;
  ListHeaderComponent?: ReactElement | null;
};
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({ testID, data, renderItem, keyExtractor, ListHeaderComponent }: MockListProps) =>
    createElement(
      'div',
      { 'data-testid': testID },
      ListHeaderComponent,
      data.map((row, index) => createElement(Fragment, { key: keyExtractor(row) }, renderItem({ item: row, index }))),
    ),
}));
type MockRowProps = {
  item: ClimbQueueItem;
  board: { boardName: string; angle: number };
  isActive: boolean;
  isRefreshing: boolean;
  refreshDisabled: boolean;
  onPress?: (item: ClimbQueueItem) => void;
  onRefresh: (uuid: string) => void;
};
const rows = vi.hoisted(() => ({ rendered: [] as MockRowProps[] }));
const summary = vi.hoisted(() => ({ shuffleDisabled: null as boolean | null }));
vi.mock('../../pre-session/WorkoutPreviewRow', () => ({
  WorkoutPreviewRow: (props: MockRowProps) => {
    rows.rendered.push(props);
    return createElement(
      'div',
      { 'data-testid': `preview-row-${props.item.uuid}` },
      props.item.climb.name,
      createElement('button', { onClick: () => props.onRefresh(props.item.uuid) }, `refresh ${props.item.uuid}`),
    );
  },
}));
vi.mock('../../pre-session/WorkoutPreviewSectionHeading', () => ({
  WorkoutPreviewSectionHeading: ({ section, count }: { section: string; count: number }) =>
    createElement('h3', null, `section ${section}:${count}`),
}));
vi.mock('../../pre-session/WorkoutPreviewStageHeading', () => ({
  WorkoutPreviewStageHeading: ({ stageKind, count }: { stageKind: string; count: number }) =>
    createElement('h3', null, `stage ${stageKind}:${count}`),
}));
vi.mock('../../pre-session/generator-controls', () => ({
  getDefaultTargetGrade: () => 15,
  toRailGrades: () => [],
}));

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('@boardsesh/analytics', () => ({ SHARED_EVENTS: { SessionQueueGenerated: 'Session Queue Generated' } }));
vi.mock('@boardsesh/board-config', () => ({ toBoardName: (boardType: string) => boardType }));
vi.mock('../../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 } }),
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../lib/haptics', () => ({ hapticSuccess: vi.fn() }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' } }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
}));
vi.mock('../../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, number>) =>
      `${key.split('.').at(-1)}${options && 'count' in options ? `:${options.count}` : ''}`,
  }),
}));
const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import {
  getWorkoutRunForSession,
  resetWorkoutRunStoreForTests,
  setWorkoutRun,
} from '../../../../lib/workout-run-store';
import { AddWorkoutBlockSheet } from '../AddWorkoutBlockSheet';

const climbItem = (uuid: string) =>
  ({ uuid, climb: { uuid: `climb-${uuid}`, name: `Climb ${uuid}`, difficulty: '6a/V3' } }) as unknown as ClimbQueueItem;

function readyPreview(uuids: string[], stageId = 'new-stage-uuid', sections?: string[]): void {
  const items = uuids.map(climbItem);
  preview.status = 'ready';
  preview.items = items.map((queueItem, index) => ({
    item: queueItem,
    slot: { grade: 20, index, section: sections?.[index] ?? 'main' },
  }));
  preview.plannedCount = uuids.length + 1;
  preview.staged = { items, run: { stages: [{ id: stageId, kind: 'pyramid', itemUuids: uuids, targetGrade: 20 }] } };
}

/** One tap on "Add to session", letting the confirm's storage read settle. */
async function press(): Promise<void> {
  await act(async () => {
    sheet.topBar?.trailing.onPress();
  });
}

function renderSheet(visible: boolean, onClose = vi.fn()) {
  render(createElement(AddWorkoutBlockSheet, { visible, onClose }));
  return { onClose };
}

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  storage.getItem.mockReset();
  storage.getItem.mockImplementation(async () => null);
  sessionListeners.clear();
  queue.sessionId = 'session-1';
  queue.queued = [];
  queue.appendQueueItems.mockReset();
  queue.appendQueueItems.mockImplementation((items: unknown[]) => items.length);
  analytics.track.mockReset();
  preview.calls = [];
  preview.status = 'ready';
  preview.items = [];
  preview.refreshingUuids = new Set();
  preview.refreshSlot.mockReset();
  rows.rendered = [];
  summary.shuffleDisabled = null;
  preview.plannedCount = 0;
  preview.staged = { items: [], run: null };
  sheet.modal = null;
  sheet.topBar = null;
  fields.block = null;
  fields.blockTypes = undefined;
});

describe('AddWorkoutBlockSheet', () => {
  it('builds nothing while closed', () => {
    renderSheet(false);
    expect(preview.calls.every((call) => call.selection.blocks.length === 0)).toBe(true);
  });

  it('opens on a block that follows the last workout stage, with no warm-up', () => {
    setWorkoutRun('session-1', {
      stages: [{ id: 'stage-pyramid', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 }],
    });
    renderSheet(true);

    expect(fields.block).toMatchObject({
      kind: 'workout',
      options: { type: 'pyramid', targetGrade: 18, warmUp: 'none' },
    });
    expect(preview.calls.at(-1)?.selection.blocks).toMatchObject([{ kind: 'workout', options: { type: 'pyramid' } }]);
  });

  it('offers the workout types only, never a warm-up', () => {
    renderSheet(true);

    expect(fields.blockTypes).toEqual(['volume', 'pyramid', 'ladder', 'gradeFocus']);
  });

  it('asks the preview to pass over the climbs already queued', () => {
    queue.queued = [{ uuid: 'q1', climb: { uuid: 'climb-queued' } }];
    renderSheet(true);

    const avoided = preview.calls.at(-1)?.options.getAvoidedClimbUuids?.();
    expect(avoided).toEqual(new Set(['climb-queued']));
  });

  it('queues the climbs behind the live queue and adds their stage to the run', async () => {
    setWorkoutRun('session-1', {
      stages: [{ id: 'stage-pyramid', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 }],
    });
    readyPreview(['l1', 'l2']);
    const { onClose } = renderSheet(true);
    expect(screen.getByText('Climb l1')).toBeTruthy();
    expect(sheet.topBar?.trailing.disabled).toBe(false);

    await press();

    // One argument: the wall never moves.
    expect(queue.appendQueueItems.mock.calls).toEqual([[preview.staged.items]]);
    expect(getWorkoutRunForSession('session-1')).toEqual({
      stages: [
        { id: 'stage-pyramid', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 },
        { id: 'new-stage-uuid', kind: 'pyramid', itemUuids: ['l1', 'l2'], targetGrade: 20 },
      ],
    });
    expect(analytics.track).toHaveBeenCalledWith('Session Queue Generated', {
      workoutType: 'pyramid',
      workoutTypes: 'pyramid',
      boardName: 'kilter',
      angle: 40,
      savedCount: 2,
      failedCount: 1,
      stageCount: 1,
      phase: 'in_session',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('turns a session without a workout into one', async () => {
    readyPreview(['v1']);
    renderSheet(true);

    await press();

    expect(getWorkoutRunForSession('session-1')).toEqual(preview.staged.run);
  });

  it('keeps Add to session off until the preview is ready', async () => {
    readyPreview(['v1']);
    preview.status = 'loading';
    renderSheet(true);

    expect(sheet.topBar?.trailing.disabled).toBe(true);
    await press();
    expect(queue.appendQueueItems).not.toHaveBeenCalled();
  });

  it('says so and stays open when the queue is full', async () => {
    readyPreview(['v1']);
    queue.appendQueueItems.mockImplementation(() => 0);
    const { onClose } = renderSheet(true);

    await press();

    expect(screen.getByText(/error:addBlockQueueFull/)).toBeTruthy();
    expect(getWorkoutRunForSession('session-1')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the no-climbs card when nothing fits the block', () => {
    preview.status = 'ready';
    renderSheet(true);

    expect(screen.getByText('addBlockPreviewEmpty')).toBeTruthy();
    expect(sheet.topBar?.trailing.disabled).toBe(true);
  });

  it('closes when the session ends while it is open', () => {
    const { onClose } = renderSheet(true);
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      queue.sessionId = null;
      for (const listener of sessionListeners) listener();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('queues the block once when Add to session is tapped twice', async () => {
    readyPreview(['v1', 'v2']);
    renderSheet(true);

    await act(async () => {
      sheet.topBar?.trailing.onPress();
      sheet.topBar?.trailing.onPress();
    });

    expect(queue.appendQueueItems).toHaveBeenCalledTimes(1);
    expect(analytics.track).toHaveBeenCalledTimes(1);
  });

  it('ignores a tap while the sheet slides away', async () => {
    readyPreview(['v1']);
    const onClose = vi.fn();
    const view = render(createElement(AddWorkoutBlockSheet, { visible: true, onClose }));
    view.rerender(createElement(AddWorkoutBlockSheet, { visible: false, onClose }));

    expect(sheet.topBar).not.toBeNull();
    await act(async () => {
      sheet.topBar?.trailing.onPress();
    });
    expect(queue.appendQueueItems).not.toHaveBeenCalled();
  });

  it('leaves out a climb already in the queue', async () => {
    readyPreview(['v1', 'v2']);
    queue.queued = [{ uuid: 'v1', climb: { uuid: 'climb-v1' } }];
    renderSheet(true);

    await press();

    expect(queue.appendQueueItems.mock.calls).toEqual([[[climbItem('v2')]]]);
    expect(getWorkoutRunForSession('session-1')?.stages[0].itemUuids).toEqual(['v2']);
  });

  it('closes without queueing when the session switches during the confirm', async () => {
    let finishRead: (value: string | null) => void = () => undefined;
    storage.getItem.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          finishRead = resolve;
        }),
    );
    readyPreview(['v1']);
    const { onClose } = renderSheet(true);

    await act(async () => {
      sheet.topBar?.trailing.onPress();
    });
    await act(async () => {
      queue.sessionId = 'session-2';
      for (const listener of sessionListeners) listener();
      finishRead(null);
    });

    expect(queue.appendQueueItems).not.toHaveBeenCalled();
    expect(getWorkoutRunForSession('session-1')).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the Start run when the confirm beats the cold-start read', async () => {
    const startRun: WorkoutRun = {
      stages: [{ id: 'stage-start', kind: 'volume', itemUuids: ['s1'], targetGrade: 16 }],
    };
    storage.getItem.mockImplementation(async () => JSON.stringify({ sessionId: 'session-1', run: startRun }));
    readyPreview(['v1']);
    renderSheet(true);
    expect(getWorkoutRunForSession('session-1')).toBeNull();

    await press();

    expect(getWorkoutRunForSession('session-1')?.stages.map((stage) => stage.id)).toEqual([
      'stage-start',
      'new-stage-uuid',
    ]);
  });
  it('lists every climb of the block with the preview rows, thumbnails and all', () => {
    const uuids = Array.from({ length: 12 }, (_unused, index) => `v${index + 1}`);
    readyPreview(uuids);
    renderSheet(true);

    const list = screen.getByTestId('add-workout-block-preview');
    for (const uuid of uuids) {
      expect(list.querySelector(`[data-testid="preview-row-${uuid}"]`)).toBeTruthy();
    }
    // The rows draw the climb on the active board (thumbnail and grade colours).
    expect(rows.rendered.at(-1)?.board).toMatchObject({ boardName: 'kilter', angle: 40 });
  });

  it('shows a pyramid going up and down, as the Record tab does for one block', () => {
    readyPreview(['p1', 'p2', 'p3', 'p4'], 'new-stage-uuid', ['increasing', 'increasing', 'peak', 'decreasing']);
    renderSheet(true);

    expect(screen.getByText('section increasing:2')).toBeTruthy();
    expect(screen.getByText('section peak:1')).toBeTruthy();
    expect(screen.getByText('section decreasing:1')).toBeTruthy();
  });

  it('regenerates only the row whose refresh was tapped', () => {
    readyPreview(['v1', 'v2', 'v3']);
    renderSheet(true);

    act(() => {
      screen.getByText('refresh v2').click();
    });

    expect(preview.refreshSlot.mock.calls).toEqual([['v2']]);
  });

  it('holds the other rows while one regenerates, and Add to session with them', () => {
    readyPreview(['v1', 'v2']);
    preview.refreshingUuids = new Set(['v1']);
    renderSheet(true);

    const latestRow = (uuid: string) => rows.rendered.filter((row) => row.item.uuid === uuid).at(-1);
    expect(latestRow('v1')).toMatchObject({ isRefreshing: true, refreshDisabled: false });
    expect(latestRow('v2')).toMatchObject({ isRefreshing: false, refreshDisabled: true });
    expect(sheet.topBar?.trailing.disabled).toBe(true);
  });

  it('never opens the player from a row, which would land under the sheet', () => {
    readyPreview(['v1', 'v2']);
    renderSheet(true);

    expect(rows.rendered.length).toBeGreaterThan(0);
    for (const row of rows.rendered) {
      expect(row.onPress).toBeUndefined();
      expect(row.isActive).toBe(false);
    }
  });

  // The confirm takes the climbs before it awaits the store, so a refresh or a
  // shuffle in that gap would change rows that are no longer the ones queued.
  it('holds every refresh and Shuffle while Add to session runs', async () => {
    let finishRead: (value: string | null) => void = () => undefined;
    storage.getItem.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          finishRead = resolve;
        }),
    );
    readyPreview(['v1', 'v2']);
    renderSheet(true);
    const latestRow = (uuid: string) => rows.rendered.filter((row) => row.item.uuid === uuid).at(-1);
    expect(latestRow('v1')?.refreshDisabled).toBe(false);
    expect(summary.shuffleDisabled).toBe(false);

    await press();

    expect(latestRow('v1')?.refreshDisabled).toBe(true);
    expect(latestRow('v2')?.refreshDisabled).toBe(true);
    expect(summary.shuffleDisabled).toBe(true);

    await act(async () => {
      finishRead(null);
    });
  });
});
