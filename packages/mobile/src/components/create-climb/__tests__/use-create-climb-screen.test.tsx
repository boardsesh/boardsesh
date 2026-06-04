// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useCreateClimbScreen, type CreateClimbBoard } from '../use-create-climb-screen';

// All platform I/O the controller reaches for is mocked here. The shared hold
// machine (`useCreateClimb`), `climbToQueueItem`, and `isDuplicateClimbError`
// stay REAL so the orchestration — Set Active uuid/angle, the save state
// machine, autosave, duplicate handling, draft restore — is exercised end-to-end.
const mocks = vi.hoisted(() => ({
  saveClimb: vi.fn(),
  updateClimb: vi.fn(),
  setCurrentClimb: vi.fn(),
  showToast: vi.fn(),
  routerPush: vi.fn(),
  refreshAuthState: vi.fn(),
  loadDraft: vi.fn(),
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  uuid: { n: 0 },
  state: {
    isAuthenticated: true,
    profile: { displayName: 'Tester' } as { displayName: string } | null,
    climb: null as Record<string, unknown> | null,
    bluetooth: null as unknown,
  },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mocks.uuid.n}` }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.routerPush }) }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('@boardsesh/board-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/board-react')>();
  return {
    ...actual, // keep the real isDuplicateClimbError
    useBoardProvider: () => ({
      isAuthenticated: mocks.state.isAuthenticated,
      saveClimb: mocks.saveClimb,
      updateClimb: mocks.updateClimb,
    }),
  };
});

vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ refreshAuthState: mocks.refreshAuthState }),
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: mocks.state.profile }),
  useClimb: () => ({ data: mocks.state.climb }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueue: () => ({ setCurrentClimb: mocks.setCurrentClimb }),
}));

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => mocks.state.bluetooth,
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

vi.mock('../../../lib/create-climb-draft-store', () => ({
  loadDraft: (...args: unknown[]) => mocks.loadDraft(...args),
  saveDraft: (...args: unknown[]) => mocks.saveDraft(...args),
  clearDraft: (...args: unknown[]) => mocks.clearDraft(...args),
  createClimbDraftKey: (config: CreateClimbBoard) =>
    `${config.boardName}:${config.layoutId}:${config.sizeId}:${config.angle}`,
}));

const board25: CreateClimbBoard = { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 25 };
const board40: CreateClimbBoard = { ...board25, angle: 40 };

function renderController(initialBoard: CreateClimbBoard = board25) {
  return renderHook((props: { board: CreateClimbBoard }) => useCreateClimbScreen(props), {
    initialProps: { board: initialBoard },
  });
}

/** Flush the mount-time draft restore (loadDraft resolves -> restoredRef set). */
async function flushMount() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The Climb pushed to the queue by the most recent setCurrentClimb call. */
function lastQueuedClimb() {
  const calls = mocks.setCurrentClimb.mock.calls;
  return (calls[calls.length - 1][0] as ClimbQueueItem).climb;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.uuid.n = 0;
  mocks.state.isAuthenticated = true;
  mocks.state.profile = { displayName: 'Tester' };
  mocks.state.climb = null;
  mocks.state.bluetooth = null;
  mocks.saveClimb.mockReset().mockResolvedValue({ uuid: 'c-25', createdAt: null, publishedAt: null });
  mocks.updateClimb.mockReset().mockResolvedValue({ uuid: 'c-25', createdAt: null, publishedAt: null, isDraft: true });
  mocks.setCurrentClimb.mockReset();
  mocks.showToast.mockReset();
  mocks.routerPush.mockReset();
  mocks.loadDraft.mockReset().mockResolvedValue(null);
  mocks.saveDraft.mockReset();
  mocks.clearDraft.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCreateClimbScreen', () => {
  it('regression: Set Active after an angle change carries the new angle and a fresh uuid', async () => {
    const view = renderController(board25);
    await flushMount();

    // Paint a valid climb and save it at 25°.
    act(() => {
      view.result.current.setName('Angle Test');
      view.result.current.handlePaint(1);
    });
    await act(async () => {
      await view.result.current.handleSave();
    });
    expect(mocks.saveClimb).toHaveBeenCalledTimes(1);

    // Set Active while still at 25° uses the saved climb's uuid.
    mocks.setCurrentClimb.mockClear();
    act(() => view.result.current.handleSetActive());
    expect(lastQueuedClimb()).toMatchObject({ uuid: 'c-25', angle: 25 });

    // Switch the working angle to 40° — same mounted screen, new board prop.
    view.rerender({ board: board40 });
    mocks.setCurrentClimb.mockClear();
    act(() => view.result.current.handleSetActive());

    // The 25° saved identity is dropped: the queue item must NOT reuse c-25,
    // and it must carry the new 40° angle (no uuid/angle mismatch).
    const queued = lastQueuedClimb();
    expect(queued.uuid).not.toBe('c-25');
    expect(queued.angle).toBe(40);
  });

  it('Set Active uses a stable preview uuid before save, the saved uuid after, and a fresh one after clear', async () => {
    const view = renderController();
    await flushMount();

    act(() => view.result.current.handlePaint(1));
    act(() => view.result.current.handleSetActive());
    const previewUuid = lastQueuedClimb().uuid;
    expect(previewUuid).toMatch(/^uuid-/);

    // Re-tapping reuses the same provisional uuid (same queue slot).
    act(() => view.result.current.handleSetActive());
    expect(lastQueuedClimb().uuid).toBe(previewUuid);

    // After save it switches to the saved row's uuid.
    act(() => view.result.current.setName('Lifecycle'));
    await act(async () => {
      await view.result.current.handleSave();
    });
    act(() => view.result.current.handleSetActive());
    expect(lastQueuedClimb().uuid).toBe('c-25');

    // Clear mints a fresh identity; the next Set Active uses neither old uuid.
    act(() => view.result.current.handleClear());
    act(() => view.result.current.handlePaint(2));
    act(() => view.result.current.handleSetActive());
    const afterClearUuid = lastQueuedClimb().uuid;
    expect(afterClearUuid).not.toBe('c-25');
    expect(afterClearUuid).not.toBe(previewUuid);
  });

  it('routes to login and skips the mutation when unauthenticated', async () => {
    mocks.state.isAuthenticated = false;
    const view = renderController();
    await flushMount();

    await act(async () => {
      await view.result.current.handleSave();
    });

    expect(mocks.routerPush).toHaveBeenCalledWith('/auth/login');
    expect(mocks.saveClimb).not.toHaveBeenCalled();
  });

  it('asks the screen to open settings when saving without a name', async () => {
    const view = renderController();
    await flushMount();

    act(() => view.result.current.handlePaint(1));
    expect(view.result.current.openSettingsSignal).toBe(0);

    await act(async () => {
      await view.result.current.handleSave();
    });

    expect(view.result.current.openSettingsSignal).toBe(1);
    expect(mocks.saveClimb).not.toHaveBeenCalled();
  });

  it('runs the save state machine through justSaved and back to ready', async () => {
    const view = renderController();
    await flushMount();

    act(() => {
      view.result.current.setName('Stateful');
      view.result.current.handlePaint(1);
    });
    expect(view.result.current.saveState).toBe('ready');

    await act(async () => {
      await view.result.current.handleSave();
    });
    expect(mocks.saveClimb).toHaveBeenCalledTimes(1);
    expect(mocks.setCurrentClimb).toHaveBeenCalled();
    expect(mocks.clearDraft).toHaveBeenCalled();
    expect(view.result.current.saveState).toBe('justSaved');

    act(() => vi.advanceTimersByTime(3000));
    expect(view.result.current.saveState).toBe('ready');
  });

  it('updates the existing row instead of creating a new one within the edit window', async () => {
    const view = renderController();
    await flushMount();

    act(() => {
      view.result.current.setName('Updatable');
      view.result.current.handlePaint(1);
    });
    await act(async () => {
      await view.result.current.handleSave();
    });
    expect(mocks.saveClimb).toHaveBeenCalledTimes(1);

    // Second save with a tracked draft row -> update in place.
    await act(async () => {
      await view.result.current.handleSave();
    });
    expect(mocks.updateClimb).toHaveBeenCalledTimes(1);
    expect(mocks.saveClimb).toHaveBeenCalledTimes(1);
  });

  it('surfaces a duplicate publish inline and other errors as a toast', async () => {
    const dupError = new GraphQLOperationError([
      {
        message: 'duplicate',
        extensions: { code: 'CLIMB_IS_DUPLICATE', existingClimbUuid: 'c-existing', existingClimbName: 'Existing' },
      },
    ]);
    mocks.saveClimb.mockRejectedValueOnce(dupError);

    const view = renderController();
    await flushMount();

    act(() => {
      view.result.current.setName('Dup');
      view.result.current.handlePaint(1);
    });
    await act(async () => {
      await view.result.current.handleSave();
    });
    expect(view.result.current.publishDuplicateError).toEqual({
      existingClimbUuid: 'c-existing',
      existingClimbName: 'Existing',
    });
    expect(mocks.showToast).not.toHaveBeenCalled();

    // A non-duplicate failure falls back to a toast.
    mocks.saveClimb.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await view.result.current.handleSave();
    });
    expect(mocks.showToast).toHaveBeenCalledWith('createClimbForm.alerts.saveFailedFallback', 'error');
  });

  it('autosaves the working draft after the debounce and clears it on Clear', async () => {
    const view = renderController();
    await flushMount();

    act(() => view.result.current.handlePaint(1));
    act(() => vi.advanceTimersByTime(500));
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      'kilter:1:1:25',
      expect.objectContaining({ isDraft: true }),
    );

    act(() => view.result.current.handleClear());
    expect(mocks.clearDraft).toHaveBeenCalledWith('kilter:1:1:25');
  });

  it('restores a previously saved local draft on mount', async () => {
    mocks.loadDraft.mockResolvedValueOnce({
      holdsJson: '{}',
      name: 'Restored',
      description: 'From storage',
      isDraft: false,
    });

    const view = renderController();
    await flushMount();

    expect(view.result.current.name).toBe('Restored');
    expect(view.result.current.description).toBe('From storage');
    expect(view.result.current.isDraft).toBe(false);
  });
});
