// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sprayWallRemovalGeneration, unregisterSprayWall } from '../../../lib/spray/spray-wall-registry';
import type { PreparedSprayHoldDraft } from '../../../lib/spray/spray-hold-maintenance';

const requests = vi.hoisted(() => ({
  prepare: vi.fn(),
  publish: vi.fn(),
  invalidate: vi.fn(),
  fetchRender: vi.fn(),
  register: vi.fn(),
  discardLeftover: vi.fn(),
}));
const refreshClimbs = vi.hoisted(() => vi.fn(async (_queryClient: unknown, _layoutId: number) => undefined));
vi.mock('../../../lib/spray/refresh-published-spray-climbs', () => ({ refreshPublishedSprayClimbs: refreshClimbs }));
const queryClient = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));
const router = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), canGoBack: vi.fn() }));
const navigation = vi.hoisted(() => ({ dispatch: vi.fn() }));
const guard = vi.hoisted(() => ({
  enabled: false,
  callback: null as ((event: { data: { action: { type: string } } }) => void) | null,
  confirm: null as (() => void) | null,
  ask: vi.fn(),
}));
type EditorProps = {
  wallUuid: string;
  layoutId: number;
  versionId: string;
  versionNumber: number;
  onCommitted: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onHandoverChange: (handingOver: boolean) => void;
};
const editor = vi.hoisted(() => ({ current: null as EditorProps | null }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
}));
vi.mock('expo-router', () => ({ useRouter: () => router, useNavigation: () => navigation }));
vi.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (enabled: boolean, callback: NonNullable<typeof guard.callback>) => {
    guard.enabled = enabled;
    guard.callback = callback;
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/graphql/operations/spray-walls', () => ({
  CREATE_SPRAY_WALL_VERSION: 'createVersion',
  PUBLISH_SPRAY_WALL_VERSION: 'publishVersion',
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  fetchSprayWallVersions: vi.fn(),
  mySprayWallsQueryKey: ['mySprayWalls'],
  sprayWallWithVersionsQueryKey: (wallUuid: string) => ['sprayWallWithVersions', wallUuid],
  useDiscardSprayWallVersion: () => ({ mutateAsync: requests.discardLeftover, isPending: false }),
}));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({
  invalidateSprayWallRenderData: requests.invalidate,
  fetchSprayWallRenderData: requests.fetchRender,
  registerRenderData: requests.register,
}));
vi.mock('../../../lib/spray/spray-hold-maintenance', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/spray/spray-hold-maintenance')>();
  return { ...original, prepareSprayHoldDraft: requests.prepare, publishSprayHoldDraft: requests.publish };
});
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#000' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16, 6: 24 } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
}));
vi.mock('../../outline-editor/SprayHoldEditorScreen', () => ({
  SprayHoldEditorScreen: (props: EditorProps) => {
    editor.current = props;
    return createElement('button', { onClick: props.onCommitted, 'data-testid': 'editor' }, 'commit holds');
  },
  confirmDiscardSprayEdits: (dirty: boolean, action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    guard.ask();
    guard.confirm = action;
  },
}));

const { SprayWallHoldsScreen } = await import('../SprayWallHoldsScreen');
const { BIND_STAGE_DEADLINE_MS } = await import('../../../lib/spray/post-publish-bind');
const draft: PreparedSprayHoldDraft = {
  wallUuid: 'wall-1',
  layoutId: 42,
  versionId: 'draft-2',
  versionNumber: 2,
  viewerCanEdit: true,
};
const publishedRender = { wall: { uuid: 'wall-1' }, versionNumber: 2 };

function editorProps(): EditorProps {
  if (!editor.current) throw new Error('editor not mounted');
  return editor.current;
}

function tryRemove() {
  const action = { type: 'GO_BACK' };
  if (guard.enabled) guard.callback?.({ data: { action } });
  else navigation.dispatch(action);
}

beforeEach(() => {
  vi.clearAllMocks();
  requests.prepare.mockReset().mockResolvedValue(draft);
  requests.publish.mockReset().mockResolvedValue(undefined);
  requests.invalidate.mockReset().mockResolvedValue(undefined);
  requests.fetchRender.mockReset().mockResolvedValue(publishedRender);
  requests.register.mockReset().mockReturnValue(true);
  requests.discardLeftover.mockReset().mockResolvedValue(true);
  queryClient.invalidateQueries.mockResolvedValue(undefined);
  refreshClimbs.mockClear();
  router.canGoBack.mockReturnValue(true);
  guard.enabled = false;
  guard.callback = null;
  guard.confirm = null;
  editor.current = null;
});

describe('SprayWallHoldsScreen', () => {
  it('preserves coded backend guidance for a wall version limit', async () => {
    const guidance = 'This wall has reached its version limit.';
    requests.prepare.mockRejectedValueOnce({
      response: { errors: [{ message: guidance, extensions: { code: 'SPRAY_WALL_VERSION_LIMIT_REACHED' } }] },
    });
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    await screen.findByText(guidance);
    expect(screen.queryByText('sprayMaintenance.temporarilyUnavailable')).toBeNull();
    expect(requests.publish).not.toHaveBeenCalled();
  });

  it.each([{ code: 'GRAPHQL_VALIDATION_FAILED' }, undefined])(
    'uses friendly copy for an older backend schema and can retry after it catches up (%j)',
    async (extensions) => {
      const schemaMessage = 'Field "sourceVersionId" is not defined by type "CreateSprayWallVersionInput".';
      requests.prepare.mockRejectedValueOnce({
        response: { errors: [{ message: schemaMessage, extensions }] },
      });
      render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
      await screen.findByText('sprayMaintenance.temporarilyUnavailable');
      expect(screen.queryByText(schemaMessage)).toBeNull();
      fireEvent.click(screen.getByText('sprayMaintenance.retry'));
      await screen.findByTestId('editor');
      expect(requests.prepare).toHaveBeenCalledTimes(2);
      expect(requests.publish).not.toHaveBeenCalled();
    },
  );

  it('opens the fresh prepared draft and keeps the route wall fixed across param updates', async () => {
    const { rerender } = render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    await screen.findByTestId('editor');
    expect(editorProps()).toMatchObject(draft);
    rerender(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-2' }));
    expect(editorProps()).toMatchObject(draft);
    expect(requests.prepare).toHaveBeenCalledTimes(1);
    expect(requests.prepare.mock.calls[0][0]).toBe('wall-1');
  });

  it('publishes after save, awaits a renderable published wall, then returns', async () => {
    let resolveRefresh: (result: typeof publishedRender) => void = () => {};
    requests.fetchRender.mockReturnValue(
      new Promise<typeof publishedRender>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByTestId('editor'));
    await waitFor(() => expect(requests.fetchRender).toHaveBeenCalledTimes(1));
    expect(requests.publish).toHaveBeenCalledTimes(1);
    expect(guard.enabled).toBe(true);
    expect(router.back).not.toHaveBeenCalled();
    await act(async () => resolveRefresh(publishedRender));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    // The generation is noted before the fetch and handed to both, so the
    // owner's wall registers as editable by the owner who just published it.
    const [, , fetchedUnder] = requests.fetchRender.mock.calls[0] as unknown[];
    expect(typeof fetchedUnder).toBe('number');
    expect(requests.register).toHaveBeenCalledWith(42, publishedRender, undefined, fetchedUnder, expect.any(Number));
    expect(guard.enabled).toBe(false);
  });

  it('keeps a removed wall unavailable when its published refresh finishes late', async () => {
    let resolveRefresh: ((result: typeof publishedRender) => void) | undefined;
    requests.fetchRender.mockReturnValue(
      new Promise<typeof publishedRender>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    requests.register.mockImplementation(
      (layoutId: number, _payload: unknown, _look: unknown, _viewer: unknown, removalGeneration: number) =>
        removalGeneration === sprayWallRemovalGeneration(layoutId),
    );
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    const startedUnder = sprayWallRemovalGeneration(42);
    fireEvent.click(await screen.findByTestId('editor'));
    await waitFor(() => expect(requests.fetchRender).toHaveBeenCalledTimes(1));
    unregisterSprayWall(42);

    await act(async () => resolveRefresh?.(publishedRender));

    await screen.findByText('sprayMaintenance.refreshFailed');
    expect(requests.register.mock.calls[0][4]).toBe(startedUnder);
    expect(router.back).not.toHaveBeenCalled();
    expect(requests.publish).toHaveBeenCalledTimes(1);
  });

  it('retries a failed publish without losing the saved draft or saving again', async () => {
    requests.publish.mockRejectedValueOnce(new Error('publish failed')).mockResolvedValueOnce(undefined);
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByTestId('editor'));
    await screen.findByText('sprayMaintenance.publishFailed');
    expect(screen.queryByTestId('editor')).toBeNull();
    fireEvent.click(screen.getByText('sprayMaintenance.retry'));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(requests.publish).toHaveBeenCalledTimes(2);
    expect(requests.publish.mock.calls.every(([prepared]) => prepared === draft)).toBe(true);
  });

  it.each([null, { wall: { uuid: 'wall-2' }, versionNumber: 2 }, { wall: { uuid: 'wall-1' }, versionNumber: 1 }])(
    'keeps a failed published refresh retry separate from publication',
    async (renderResponse) => {
      requests.fetchRender.mockResolvedValueOnce(renderResponse).mockResolvedValueOnce(publishedRender);
      render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
      fireEvent.click(await screen.findByTestId('editor'));
      await screen.findByText('sprayMaintenance.refreshFailed');
      fireEvent.click(screen.getByText('sprayMaintenance.retry'));
      await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
      expect(requests.publish).toHaveBeenCalledTimes(1);
      expect(requests.fetchRender).toHaveBeenCalledTimes(2);
    },
  );

  it('fails into Retry when the published refresh never settles', async () => {
    // Both awaits can sit on a refetch paused offline, and the leave guard holds
    // every way out while they do — so the ceiling is the only exit.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      requests.fetchRender.mockReturnValueOnce(new Promise<never>(() => {}));
      render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
      fireEvent.click(await screen.findByTestId('editor'));
      await waitFor(() => expect(requests.fetchRender).toHaveBeenCalledTimes(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(BIND_STAGE_DEADLINE_MS);
      });
      await screen.findByText('sprayMaintenance.refreshFailed');
      expect(router.back).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('sprayMaintenance.retry'));
      await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
      expect(requests.publish).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes downloaded integrity and the visible climb list after publishing', async () => {
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByTestId('editor'));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    expect(requests.publish).toHaveBeenCalledTimes(1);
    expect(refreshClimbs).toHaveBeenCalledExactlyOnceWith(queryClient, draft.layoutId);
  });

  it('stays on the refresh error when the payload cannot render', async () => {
    requests.register.mockReturnValue(false);
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByTestId('editor'));
    await screen.findByText('sprayMaintenance.refreshFailed');
    expect(router.back).not.toHaveBeenCalled();
    expect(requests.publish).toHaveBeenCalledTimes(1);
  });

  it.each(['fetch failed', 'render unavailable'])(
    'retries %s after publication without publishing again',
    async (refreshFailure) => {
      if (refreshFailure === 'fetch failed') {
        requests.fetchRender.mockRejectedValueOnce(new Error('offline'));
      } else {
        requests.register.mockReturnValueOnce(false);
      }
      render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
      fireEvent.click(await screen.findByTestId('editor'));
      await screen.findByText('sprayMaintenance.refreshFailed');
      expect(router.back).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('sprayMaintenance.retry'));
      await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
      expect(requests.fetchRender).toHaveBeenCalledTimes(2);
      expect(requests.publish).toHaveBeenCalledTimes(1);
    },
  );

  it('guards dirty native removal and rechecks handover after confirmation', async () => {
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    await screen.findByTestId('editor');
    act(() => editorProps().onDirtyChange(true));
    expect(guard.enabled).toBe(true);
    act(tryRemove);
    expect(guard.ask).toHaveBeenCalledTimes(1);
    expect(navigation.dispatch).not.toHaveBeenCalled();
    act(() => editorProps().onHandoverChange(true));
    act(() => guard.confirm?.());
    expect(navigation.dispatch).not.toHaveBeenCalled();
    act(() => editorProps().onHandoverChange(false));
    act(() => guard.confirm?.());
    expect(navigation.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'GO_BACK' });
  });

  it('blocks removal during preparation and publication without asking', async () => {
    let resolvePreparation: (result: PreparedSprayHoldDraft) => void = () => {};
    requests.prepare.mockReturnValue(
      new Promise<PreparedSprayHoldDraft>((resolve) => {
        resolvePreparation = resolve;
      }),
    );
    requests.publish.mockReturnValue(new Promise<void>(() => {}));
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    act(tryRemove);
    expect(guard.ask).not.toHaveBeenCalled();
    expect(navigation.dispatch).not.toHaveBeenCalled();
    await act(async () => resolvePreparation(draft));
    fireEvent.click(await screen.findByTestId('editor'));
    act(tryRemove);
    expect(guard.ask).not.toHaveBeenCalled();
    expect(navigation.dispatch).not.toHaveBeenCalled();
  });

  it('retries a failed fresh read and can leave without deleting the draft', async () => {
    requests.prepare.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(draft);
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    await screen.findByText('sprayMaintenance.loadFailed');
    expect(guard.enabled).toBe(false);
    fireEvent.click(screen.getByText('sprayMaintenance.retry'));
    await screen.findByTestId('editor');
    expect(requests.prepare).toHaveBeenCalledTimes(2);
    act(tryRemove);
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    expect(requests.publish).not.toHaveBeenCalled();
  });

  it('returns deep links without a previous screen to the board picker', async () => {
    router.canGoBack.mockReturnValue(false);
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByTestId('editor'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledExactlyOnceWith('/boards'));
    expect(router.back).not.toHaveBeenCalled();
  });

  // A deep link or a sheet that rendered before the first climb was published
  // must not reach the editor: the screen says why and offers only the way back.
  it.each([
    ['holdsLocked', 'mobile.boardDetail.spray.holdsLockedHint'],
    ['archived', 'sprayWallErrors.archived'],
  ] as const)('explains a %s wall and offers no retry', async (reason, copy) => {
    const { SprayHoldMaintenanceError } = await import('../../../lib/spray/spray-hold-maintenance');
    requests.prepare.mockRejectedValueOnce(new SprayHoldMaintenanceError(reason));
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    await screen.findByText(copy);
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.queryByText('sprayMaintenance.retry')).toBeNull();
    expect(screen.queryByText('sprayMaintenance.discardStrandedDraft')).toBeNull();
    fireEvent.click(screen.getByText('sprayWizard.back'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  // Hold changes opened before the wall locked can never be published, and
  // nothing else would clear them. The owner discards them with a tap, never
  // automatically, and the screen then settles on the plain locked state.
  it.each(['holdsLocked', 'archived'] as const)(
    'offers to discard a draft left on a %s wall, then shows the plain locked state',
    async (reason) => {
      const { SprayHoldMaintenanceError } = await import('../../../lib/spray/spray-hold-maintenance');
      requests.prepare
        .mockRejectedValueOnce(new SprayHoldMaintenanceError(reason, 'draft-4'))
        .mockRejectedValueOnce(new SprayHoldMaintenanceError(reason));
      render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
      await screen.findByText('sprayMaintenance.strandedDraft');
      expect(requests.discardLeftover).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('sprayMaintenance.discardStrandedDraft'));
      await waitFor(() => expect(requests.prepare).toHaveBeenCalledTimes(2));
      expect(requests.discardLeftover).toHaveBeenCalledExactlyOnceWith('draft-4');
      await waitFor(() => expect(screen.queryByText('sprayMaintenance.strandedDraft')).toBeNull());
      expect(screen.queryByText('sprayMaintenance.discardStrandedDraft')).toBeNull();
      expect(screen.queryByText('sprayMaintenance.retry')).toBeNull();
      expect(screen.queryByTestId('editor')).toBeNull();
    },
  );

  it('keeps the offer up when discarding a draft left on a locked wall fails', async () => {
    const { SprayHoldMaintenanceError } = await import('../../../lib/spray/spray-hold-maintenance');
    requests.prepare.mockRejectedValueOnce(new SprayHoldMaintenanceError('holdsLocked', 'draft-4'));
    requests.discardLeftover.mockRejectedValueOnce(new Error('offline'));
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByText('sprayMaintenance.discardStrandedDraft'));
    await screen.findByText('sprayMaintenance.discardStrandedDraftFailed');
    expect(screen.getByText('sprayMaintenance.discardStrandedDraft')).toBeTruthy();
    expect(requests.prepare).toHaveBeenCalledTimes(1);
  });

  it("says a server refusal for a locked wall in the climber's words, without a retry", async () => {
    requests.publish.mockRejectedValueOnce({
      response: { errors: [{ message: 'Holds are locked.', extensions: { code: 'SPRAY_WALL_HOLDS_LOCKED' } }] },
    });
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByTestId('editor'));
    await screen.findByText('sprayWallErrors.holdsLocked');
    expect(screen.queryByText('Holds are locked.')).toBeNull();
    expect(screen.queryByText('sprayMaintenance.retry')).toBeNull();
  });

  // The retired in-place reset could leave a new-photo draft on a live wall.
  // Discarding it keeps the wall and its climbs, and the editor then opens.
  it('discards an unfinished photo from the old reset, then opens the editor', async () => {
    const { SprayHoldMaintenanceError } = await import('../../../lib/spray/spray-hold-maintenance');
    requests.prepare
      .mockRejectedValueOnce(new SprayHoldMaintenanceError('leftoverPhotoDraft', 'draft-9'))
      .mockResolvedValueOnce(draft);
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    await screen.findByText('sprayMaintenance.leftoverPhoto');
    fireEvent.click(screen.getByText('sprayMaintenance.discardLeftover'));
    await screen.findByTestId('editor');
    expect(requests.discardLeftover).toHaveBeenCalledExactlyOnceWith('draft-9');
    expect(requests.prepare).toHaveBeenCalledTimes(2);
  });

  it('keeps the discard offer up when the discard fails', async () => {
    const { SprayHoldMaintenanceError } = await import('../../../lib/spray/spray-hold-maintenance');
    requests.prepare.mockRejectedValueOnce(new SprayHoldMaintenanceError('leftoverPhotoDraft', 'draft-9'));
    requests.discardLeftover.mockRejectedValueOnce(new Error('offline'));
    render(createElement(SprayWallHoldsScreen, { wallUuid: 'wall-1' }));
    fireEvent.click(await screen.findByText('sprayMaintenance.discardLeftover'));
    await screen.findByText('sprayMaintenance.discardLeftoverFailed');
    expect(screen.getByText('sprayMaintenance.discardLeftover')).toBeTruthy();
    expect(requests.prepare).toHaveBeenCalledTimes(1);
  });
});
