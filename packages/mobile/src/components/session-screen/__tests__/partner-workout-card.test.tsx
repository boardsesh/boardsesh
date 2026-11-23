// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AppWorkout } from '../../../lib/pending-workout-store';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import { getGradesForBoard } from '@boardsesh/board-config';
import type { PartnerWorkoutPreview } from '../../../lib/partner-workout-preview';

const state = vi.hoisted(() => ({
  sessionId: null as string | null,
  active: null as AppWorkout | null,
  run: null as WorkoutRun | null,
  hydrate: vi.fn(async () => 'clean'),
  request: vi.fn(async () => ({})),
  toast: vi.fn(),
  write: vi.fn(async () => 'queued'),
  start: vi.fn(async () => 'new-session'),
  append: vi.fn((items: ClimbQueueItem[]) => Math.min(items.length, 1)),
  activate: vi.fn(),
  prepare: vi.fn(),
  setRun: vi.fn(),
  navigate: vi.fn(),
  pending: null as AppWorkout | null,
  remember: vi.fn(async () => undefined),
  setPending: vi.fn(),
  queue: [] as ClimbQueueItem[],
  pendingStart: false,
  arm: vi.fn((_sessionId: string, _run: WorkoutRun, _nowMs: number) => true),
  preview: null as PartnerWorkoutPreview | null,
  previewQueryKey: [] as unknown[],
}));
vi.mock('expo-crypto', () => {
  let counter = 0;
  return { randomUUID: () => `qi-${counter++}` };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: state.navigate }) }));
vi.mock('react-native', () => ({ View: 'div', StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 3: 12, 4: 16 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === 'partnerWorkoutPreview') state.previewQueryKey = queryKey;
    return { data: queryKey[0] === 'partnerWorkoutWinningPlan' ? state.active : (state.preview ?? EMPTY_PREVIEW) };
  },
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useAppWorkoutsFlag: () => true }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: state.sessionId }),
  useQueueActions: () => ({
    startSession: state.start,
    appendQueueItems: state.append,
    getQueueSnapshot: () => ({ sessionId: state.sessionId, queue: state.queue, currentClimbQueueItem: null }),
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: state.toast }) }));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter' } }),
  getActiveBoardWriteGeneration: () => 0,
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: state.request }) }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getCredentialGeneration: () => 0 }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
// The real "Add a block" arm rule runs; only the arm itself is watched.
vi.mock('../../../lib/rest-timer-effective', () => ({ armRestTimerForWorkout: state.arm }));
vi.mock('../../../lib/graphql/hooks/search-grade-source', () => ({
  useSearchGradeSourceActive: () => false,
  useSearchGradeSourceSettled: () => true,
}));
vi.mock('../../../offline/session-workout-outbox', () => ({ enqueueSessionWorkoutWrite: state.write }));
vi.mock('../pre-session/select-climbs-for-plan', () => ({ fetchGradePool: vi.fn() }));
vi.mock('../../../lib/workout-run-store', () => ({
  getWorkoutRunForSession: () => state.run,
  hydrateWorkoutRun: state.hydrate,
  isWorkoutRunPendingStart: (sessionId: string | null) => sessionId !== null && state.pendingStart,
  prepareWorkoutRun: state.prepare,
  setWorkoutRun: state.setRun,
}));
vi.mock('../../../lib/pending-workout-store', () => ({
  usePendingWorkout: () => (state.active ? null : (state.pending ?? workout)),
  useActivePartnerWorkout: () => state.active,
  getPendingWorkout: () => state.pending ?? workout,
  activatePartnerWorkout: state.activate,
  clearPendingWorkout: vi.fn(),
  setPendingWorkout: state.setPending,
  rememberPartnerWorkout: state.remember,
  getPartnerWorkoutTimer: () => null,
  setPartnerWorkoutTimer: vi.fn(async () => undefined),
}));
vi.mock('../../Card', () => ({
  Card: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    onValueChange,
    disabled,
  }: {
    label: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
    disabled?: boolean;
  }) =>
    createElement('input', {
      type: 'checkbox',
      'aria-label': label,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));

import { PartnerWorkoutCard } from '../PartnerWorkoutCard';
import { buildPartnerWorkoutPlan } from '../../../lib/partner-workout-plan';
import { buildPartnerWorkoutPreview } from '../../../lib/partner-workout-preview';

const EMPTY_PREVIEW: PartnerWorkoutPreview = {
  items: [],
  run: { stages: [] },
  selectionSlots: 0,
  slots: [],
  built: {
    pools: new Map(),
    poolDemands: new Map(),
    poolTopUpTiers: new Map(),
    exhaustedPoolKeys: new Set(),
    items: [],
    usedUuids: new Set(),
    borrowScale: [],
  },
};
const workout: AppWorkout = {
  id: 'wk_one',
  clientId: 'app_one',
  title: 'Workout',
  status: 'opened',
  sourceAppName: 'Planner',
  notes: null,
  expiresAt: '2026-12-01',
  spec: { title: 'Workout', externalRef: 'one', blocks: [{ type: 'freeClimbing' }] },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.sessionId = null;
  state.active = null;
  state.run = null;
  state.pending = null;
  state.queue = [];
  state.pendingStart = false;
  state.preview = null;
  state.previewQueryKey = [];
  state.setPending.mockImplementation((pending: AppWorkout) => {
    state.pending = pending;
  });
  state.request.mockImplementation(async () => ({}));
  state.hydrate.mockResolvedValue('clean');
});

describe('partner workout card recovery', () => {
  it('offers Resume after an attachment commits while the room changes', async () => {
    state.sessionId = 'original-room';
    const committed = { ...workout, status: 'started', sessionId: 'original-room' };
    state.request.mockImplementation(async () => {
      state.sessionId = 'new-room';
      return { appWorkout: committed };
    });
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.setPending).toHaveBeenCalledWith(committed));
    expect(state.append).not.toHaveBeenCalled();
    expect(state.remember).toHaveBeenCalledWith('original-room', workout.id);
  });

  it('refetches and offers Resume after a conflict from an earlier committed Start', async () => {
    const committed = { ...workout, status: 'started', sessionId: 'original-room' };
    state.request.mockRejectedValueOnce(new Error('409 conflict')).mockResolvedValueOnce({ appWorkout: committed });
    state.sessionId = 'new-room';
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.setPending).toHaveBeenCalledWith(committed));
    expect(state.append).not.toHaveBeenCalled();
  });

  it('reopens authoritative workout details before confirming Resume', () => {
    state.pending = { ...workout, status: 'started', sessionId: 'original-room' };
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.resume'));
    expect(state.navigate).toHaveBeenCalledWith({ pathname: '/w/[workoutId]', params: { workoutId: workout.id } });
    expect(view.queryByText('partnerWorkouts.start')).toBeNull();
  });
  it('starts with the selected privacy and an atomic empty freeform seed without local append', async () => {
    const view = render(
      createElement(PartnerWorkoutCard, { startConfig: { isPublic: false, audience: 'invite_only' } }),
    );
    fireEvent.click(view.getByText('partnerWorkouts.start'));
    await waitFor(() => expect(state.activate).toHaveBeenCalled());
    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({
        isPublic: false,
        audience: 'invite_only',
        appWorkoutId: 'wk_one',
        appWorkoutSeed: expect.objectContaining({ queue: [], plan: [{ index: 0, climbUuids: [] }] }),
      }),
    );
    expect(state.append).not.toHaveBeenCalled();
  });

  it('waits for the old local run before Add, preserving its stages', async () => {
    state.sessionId = 'existing-session';
    const previous: WorkoutRun = { stages: [{ id: 'old', kind: 'volume', itemUuids: ['old-item'] }] };
    state.hydrate.mockImplementation(async () => {
      state.run = previous;
      return 'clean';
    });
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.setRun).toHaveBeenCalled());
    expect(state.hydrate).toHaveBeenCalledWith('existing-session');
    expect(state.setRun).toHaveBeenCalledWith('existing-session', previous, {});
  });

  it('does not replace a stored tick-bearing run while restoring the server winner', async () => {
    state.sessionId = 'existing-session';
    state.active = {
      ...workout,
      status: 'started',
      sessionId: state.sessionId,
      sessionPlan: {
        version: 1,
        stages: [
          { id: 'wk_one:0', kind: 'volume', items: [{ queueItemUuid: 'winner', climbUuid: 'climb', angle: 40 }] },
        ],
      },
    };
    state.hydrate.mockImplementation(async () => {
      state.run = { stages: [{ id: 'local', kind: 'volume', itemUuids: ['winner'] }] };
      return 'clean';
    });
    render(createElement(PartnerWorkoutCard));
    await waitFor(() => expect(state.hydrate).toHaveBeenCalled());
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.setRun).not.toHaveBeenCalled();
  });
});

describe('adding a partner workout to a running session', () => {
  const focusWorkout: AppWorkout = {
    ...workout,
    spec: {
      title: 'Focus',
      externalRef: 'focus',
      blocks: [{ type: 'gradeFocus', climbCount: 1, restSeconds: 60, targetGrade: { scale: 'font', value: '6B' } }],
    },
  };
  const climb = (uuid: string) => ({ uuid, name: uuid, difficulty: '6b/V4', angle: 40 }) as Climb;

  beforeEach(async () => {
    state.sessionId = 'existing-session';
    state.pending = focusWorkout;
    // Built while the queue was empty: the preview's one row is climb `first`.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    state.preview = await buildPartnerWorkoutPreview({
      spec: focusWorkout.spec,
      partnerPlan: buildPartnerWorkoutPlan(focusWorkout.spec, getGradesForBoard('kilter'), focusWorkout.id),
      grades: getGradesForBoard('kilter'),
      ctx: { board: { boardType: 'kilter' } as UserBoard, isAuthenticated: true },
      fetchPool: async () => ({ climbs: [climb('first'), climb('second')], topUpTiers: new Map(), exhausted: true }),
    });
    vi.mocked(Math.random).mockRestore();
    state.append.mockImplementation((items: ClimbQueueItem[]) => items.length);
  });

  it('keeps round workouts unstarted and offers ending the current session', () => {
    state.pending = {
      ...focusWorkout,
      spec: {
        ...focusWorkout.spec,
        blocks: [
          {
            type: 'fourByFour',
            climbCount: 4,
            rounds: 4,
            targetGrade: { scale: 'v', value: 4 },
            restBetweenClimbsSeconds: 0,
            restBetweenRoundsSeconds: 180,
          },
        ],
      },
    };
    const endCurrent = vi.fn();
    const view = render(createElement(PartnerWorkoutCard, { onEndCurrentSession: endCurrent }));
    expect(view.getByText('partnerWorkouts.newSessionRequired')).toBeTruthy();
    const add = view.getByText('partnerWorkouts.add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(state.request).not.toHaveBeenCalled();
    expect(state.append).not.toHaveBeenCalled();
    fireEvent.click(view.getByText('partnerWorkouts.endCurrent'));
    expect(endCurrent).toHaveBeenCalledOnce();
  });

  it('rechecks hydrated plan capacity before attaching', async () => {
    state.hydrate.mockImplementation(async () => {
      state.run = {
        stages: [{ id: 'old', kind: 'volume', itemUuids: Array.from({ length: 500 }, (_, index) => `old-${index}`) }],
      };
      return 'clean';
    });
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.hydrate).toHaveBeenCalled());
    expect(state.request).not.toHaveBeenCalled();
    expect(state.append).not.toHaveBeenCalled();
  });

  it('records and activates the partial non-round plan when a peer fills capacity during attachment', async () => {
    const volumeWorkout: AppWorkout = {
      ...focusWorkout,
      spec: {
        ...focusWorkout.spec,
        blocks: [{ type: 'volume', climbCount: 2, targetGrade: { scale: 'font', value: '6B' } }],
      },
    };
    state.pending = volumeWorkout;
    state.preview = await buildPartnerWorkoutPreview({
      spec: volumeWorkout.spec,
      partnerPlan: buildPartnerWorkoutPlan(volumeWorkout.spec, getGradesForBoard('kilter'), volumeWorkout.id),
      grades: getGradesForBoard('kilter'),
      ctx: { board: { boardType: 'kilter' } as UserBoard, isAuthenticated: true },
      fetchPool: async () => ({ climbs: [climb('first'), climb('second')], topUpTiers: new Map(), exhausted: true }),
    });
    state.queue = Array.from(
      { length: 498 },
      (_, index) => ({ uuid: `queued-${index}`, climb: climb(`queued-climb-${index}`) }) as ClimbQueueItem,
    );
    let finishAttachment: (() => void) | undefined;
    const attachment = new Promise<void>((resolve) => {
      finishAttachment = resolve;
    });
    state.request.mockImplementationOnce(async () => {
      await attachment;
      return {};
    });
    state.append.mockImplementation((items: ClimbQueueItem[]) => {
      const landed = items.slice(0, 500 - state.queue.length);
      state.queue = [...state.queue, ...landed];
      return landed.length;
    });
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.request).toHaveBeenCalledOnce());
    state.queue.push({ uuid: 'peer-item', climb: climb('peer-climb') } as ClimbQueueItem);
    finishAttachment?.();
    await waitFor(() => expect(state.request).toHaveBeenCalledTimes(2));
    expect(state.append).toHaveBeenCalledOnce();
    expect(state.queue).toHaveLength(500);
    const landed = state.queue.at(-1)!;
    expect(state.setRun).toHaveBeenCalledWith(
      'existing-session',
      expect.objectContaining({ stages: [expect.objectContaining({ itemUuids: [landed.uuid] })] }),
      expect.anything(),
    );
    expect(state.write).toHaveBeenCalledWith('existing-session', expect.anything());
    expect(state.activate).toHaveBeenCalledWith('existing-session', expect.objectContaining({ status: 'started' }));
    expect(state.request).toHaveBeenLastCalledWith(expect.anything(), {
      workoutId: volumeWorkout.id,
      plan: [{ index: 0, climbUuids: [landed.climb.uuid] }],
    });
    expect(state.toast).toHaveBeenCalledWith('partnerWorkouts.budgetShortfall', 'info');
  });

  it('records and activates a shorter non-round preview after post-attachment reselection', async () => {
    const originalPreview = state.preview!;
    state.preview = { ...originalPreview, selectionSlots: 2 };
    // The plan has two requested visits, while its freshly reselected catalogue
    // can only return one. This can happen when peer additions consume a pool.
    state.pending = {
      ...focusWorkout,
      spec: {
        ...focusWorkout.spec,
        blocks: [{ type: 'gradeFocus', climbCount: 2, targetGrade: { scale: 'font', value: '6B' } }],
      },
    };
    const secondItem = { uuid: 'second-preview-item', climb: climb('second') } as ClimbQueueItem;
    state.preview = { ...state.preview, items: [...originalPreview.items, secondItem] };
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.activate).toHaveBeenCalled());
    expect(state.append.mock.calls[0][0]).toHaveLength(1);
    expect(state.write).toHaveBeenCalled();
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(state.toast).toHaveBeenCalledWith('partnerWorkouts.budgetShortfall', 'info');
  });

  it('does not arm the rest timer while the session workout waits for its Start', async () => {
    state.pendingStart = true;
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.setRun).toHaveBeenCalled());
    expect(state.arm).not.toHaveBeenCalled();
  });

  it('arms the block rest when the session workout has already started', async () => {
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.arm).toHaveBeenCalled());
    expect(state.arm).toHaveBeenCalledWith(
      'existing-session',
      expect.objectContaining({ stages: [expect.objectContaining({ pacing: expect.anything() })] }),
      expect.any(Number),
    );
  });

  it('passes over a climb queued since the preview was built', async () => {
    state.queue = [{ uuid: 'queued-item', climb: climb('first') } as ClimbQueueItem];
    const view = render(createElement(PartnerWorkoutCard));
    fireEvent.click(view.getByText('partnerWorkouts.add'));
    await waitFor(() => expect(state.append).toHaveBeenCalled());
    const appended = state.append.mock.calls[0][0] as ClimbQueueItem[];
    expect(appended.map((item) => item.climb.uuid)).toEqual(['second']);
  });
});

describe('partner block rest line', () => {
  it('shows zero rests and offers the advance setting only for paced native blocks', () => {
    state.pending = {
      ...workout,
      spec: {
        title: 'Rests',
        externalRef: 'rests',
        blocks: [
          { type: 'volume', climbCount: 2, restSeconds: 0, targetGrade: { scale: 'font', value: '6B' } },
          { type: 'gradeFocus', climbCount: 2, restSeconds: 90, targetGrade: { scale: 'font', value: '6B' } },
          { type: 'limitBouldering', climbCount: 2, restSeconds: 0, targetGrade: { scale: 'font', value: '7A' } },
        ],
      },
    };
    const view = render(createElement(PartnerWorkoutCard));
    expect(view.getAllByText('partnerWorkouts.rest')).toHaveLength(3);
    expect(view.getAllByRole('checkbox')).toHaveLength(2);
  });
});

describe('partner advance preference', () => {
  beforeEach(() => {
    state.pending = {
      ...workout,
      spec: {
        ...workout.spec,
        blocks: [
          { type: 'volume', climbCount: 1, restSeconds: 60, targetGrade: { scale: 'font', value: '6B' } },
          {
            type: 'gradeFocus',
            climbCount: 1,
            restSeconds: 60,
            advanceOn: 'send',
            targetGrade: { scale: 'font', value: '6B' },
          },
        ],
      },
    };
  });

  it('defaults to advancing after falls, respects partner settings and updates only the chosen block', () => {
    const view = render(createElement(PartnerWorkoutCard));
    const previousKey = state.previewQueryKey;
    const [first, second] = view.getAllByRole('checkbox') as HTMLInputElement[];
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(false);
    fireEvent.click(first);
    expect(state.pending?.spec.blocks).toEqual([
      expect.objectContaining({ type: 'volume', advanceOn: 'send' }),
      expect.objectContaining({ type: 'gradeFocus', advanceOn: 'send' }),
    ]);
    view.rerender(createElement(PartnerWorkoutCard));
    expect(state.previewQueryKey).not.toEqual(previousKey);
    expect((view.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(view.getAllByRole('checkbox')[1]);
    expect(state.pending?.spec.blocks[1]).toMatchObject({ advanceOn: 'tick' });
  });

  it.each([false, true])(
    'persists the selected pacing when adding to an existing session: %s',
    async (existingSession) => {
      const view = render(createElement(PartnerWorkoutCard, { startConfig: { isPublic: false } }));
      fireEvent.click(view.getAllByRole('checkbox')[0]);
      const selected = state.pending!;
      state.preview = await buildPartnerWorkoutPreview({
        spec: selected.spec,
        partnerPlan: buildPartnerWorkoutPlan(selected.spec, getGradesForBoard('kilter'), selected.id),
        grades: getGradesForBoard('kilter'),
        ctx: { board: { boardType: 'kilter' } as UserBoard, isAuthenticated: true },
        fetchPool: async () => ({
          climbs: ['one', 'two', 'three'].map((uuid) => ({ uuid, name: uuid, angle: 40 }) as Climb),
          topUpTiers: new Map(),
          exhausted: true,
        }),
      });
      state.sessionId = existingSession ? 'existing-session' : null;
      view.rerender(createElement(PartnerWorkoutCard, { startConfig: { isPublic: false } }));
      fireEvent.click(view.getByText(existingSession ? 'partnerWorkouts.add' : 'partnerWorkouts.start'));
      await waitFor(() => expect(state.activate).toHaveBeenCalled());
      const stage = expect.objectContaining({
        pacing: expect.objectContaining({ advanceOn: 'send', restSeconds: 60 }),
      });
      if (existingSession)
        expect(state.setRun).toHaveBeenCalledWith(
          'existing-session',
          expect.objectContaining({ stages: [stage, stage] }),
          expect.anything(),
        );
      else
        expect(state.start).toHaveBeenCalledWith(
          expect.objectContaining({
            appWorkoutSeed: expect.objectContaining({
              sessionPlan: expect.objectContaining({ stages: [stage, stage] }),
            }),
          }),
        );
    },
  );

  it('does not offer changes once the workout has started', () => {
    state.active = { ...state.pending!, status: 'started', sessionId: 'existing-session' };
    state.pending = null;
    state.sessionId = 'existing-session';
    const view = render(createElement(PartnerWorkoutCard));
    expect(view.queryByRole('checkbox')).toBeNull();
  });
});
