// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
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
  items: [] as Array<{ item: ClimbQueueItem; slot: { grade: number; index: number } }>,
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
      refreshingUuids: new Set(),
      plannedCount: on ? preview.plannedCount : 0,
      plannedSlots: [],
      plannedStages: [],
      regenerate: vi.fn(),
      shuffle: vi.fn(),
      refreshSlot: vi.fn(),
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
    return props.visible ? createElement('div', null, props.header, props.children) : null;
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
  WorkoutPreviewSummary: () => createElement('div', null, 'summary'),
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
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (difficulty: string) => difficulty }),
}));
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
  getItem: vi.fn(async () => null),
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

function readyPreview(uuids: string[], stageId = 'new-stage-uuid'): void {
  const items = uuids.map(climbItem);
  preview.status = 'ready';
  preview.items = items.map((queueItem, index) => ({ item: queueItem, slot: { grade: 20, index } }));
  preview.plannedCount = uuids.length + 1;
  preview.staged = { items, run: { stages: [{ id: stageId, kind: 'pyramid', itemUuids: uuids, targetGrade: 20 }] } };
}

function renderSheet(visible: boolean, onClose = vi.fn()) {
  render(createElement(AddWorkoutBlockSheet, { visible, onClose }));
  return { onClose };
}

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  sessionListeners.clear();
  queue.sessionId = 'session-1';
  queue.queued = [];
  queue.appendQueueItems.mockReset();
  queue.appendQueueItems.mockImplementation((items: unknown[]) => items.length);
  analytics.track.mockReset();
  preview.calls = [];
  preview.status = 'ready';
  preview.items = [];
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

  it('queues the climbs behind the live queue and adds their stage to the run', () => {
    setWorkoutRun('session-1', {
      stages: [{ id: 'stage-pyramid', kind: 'pyramid', itemUuids: ['p1'], targetGrade: 18 }],
    });
    readyPreview(['l1', 'l2']);
    const { onClose } = renderSheet(true);
    expect(screen.getByText('Climb l1')).toBeTruthy();
    expect(sheet.topBar?.trailing.disabled).toBe(false);

    act(() => sheet.topBar?.trailing.onPress());

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

  it('turns a session without a workout into one', () => {
    readyPreview(['v1']);
    renderSheet(true);

    act(() => sheet.topBar?.trailing.onPress());

    expect(getWorkoutRunForSession('session-1')).toEqual(preview.staged.run);
  });

  it('keeps Add to session off until the preview is ready', () => {
    readyPreview(['v1']);
    preview.status = 'loading';
    renderSheet(true);

    expect(sheet.topBar?.trailing.disabled).toBe(true);
    act(() => sheet.topBar?.trailing.onPress());
    expect(queue.appendQueueItems).not.toHaveBeenCalled();
  });

  it('says so and stays open when the queue is full', () => {
    readyPreview(['v1']);
    queue.appendQueueItems.mockImplementation(() => 0);
    const { onClose } = renderSheet(true);

    act(() => sheet.topBar?.trailing.onPress());

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
});
