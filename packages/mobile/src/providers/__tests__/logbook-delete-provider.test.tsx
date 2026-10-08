// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  scope: 'account:board',
  mutation: vi.fn(),
  toast: vi.fn(),
  track: vi.fn(),
  snackbar: null as Record<string, unknown> | null,
}));
vi.mock('../queue-provider', () => ({ useQueueSessionId: () => ({ undoScope: state.scope }) }));
vi.mock('@boardsesh/board-react', () => ({ useDeleteTick: () => ({ mutateAsync: state.mutation }) }));
vi.mock('../toast-provider', () => ({ useToast: () => ({ showToast: state.toast }) }));
vi.mock('../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ floatingControlBottom: 10 }),
}));
vi.mock('../../lib/analytics', () => ({ track: state.track }));
vi.mock('../../lib/haptics', () => ({ hapticSuccess: vi.fn() }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { absoluteFill: {} },
}));
vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-overlay': true }, children),
}));
vi.mock('react-native-paper', () => ({ Portal: ({ children }: { children?: ReactNode }) => children }));
vi.mock('../../components/UndoSnackbar', () => ({
  UndoSnackbar: (props: Record<string, unknown>) => {
    state.snackbar = props;
    return createElement('span', null, 'Undo offer');
  },
}));
import {
  LOGBOOK_DELETE_UNDO_MS,
  LogbookDeleteProvider,
  useLogbookDeleteActions,
  usePendingLogbookDeletes,
} from '../logbook-delete-provider';
let actions: ReturnType<typeof useLogbookDeleteActions>;
let hidden: ReadonlySet<string>;
function Route() {
  actions = useLogbookDeleteActions();
  hidden = usePendingLogbookDeletes();
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  state.scope = 'account:board';
  state.mutation.mockReset().mockResolvedValue(true);
  state.toast.mockReset();
  state.track.mockReset();
  state.snackbar = null;
});
afterEach(() => {
  vi.useRealTimers();
});
describe('persistent logbook delete Undo', () => {
  it('hides the entry and Undo cancels before any irreversible request', async () => {
    render(
      <LogbookDeleteProvider>
        <Route />
      </LogbookDeleteProvider>,
    );
    act(() => {
      expect(actions.scheduleDelete({ originScope: 'account:board', uuid: 'tick', method: 'swipe' })).toBe(true);
    });
    expect(hidden.has('tick')).toBe(true);
    expect(state.mutation).not.toHaveBeenCalled();
    act(() => {
      (state.snackbar?.onUndo as () => void)();
    });
    expect(hidden.has('tick')).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(LOGBOOK_DELETE_UNDO_MS));
    expect(state.mutation).not.toHaveBeenCalled();
  });
  it('keeps the deadline after leaving the route or dismissing the visual offer', async () => {
    const screen = render(
      <LogbookDeleteProvider>
        <Route />
      </LogbookDeleteProvider>,
    );
    act(() => {
      actions.scheduleDelete({ originScope: 'account:board', uuid: 'tick', method: 'a11y' });
    });
    act(() => {
      (state.snackbar?.onDismiss as () => void)();
    });
    screen.rerender(<LogbookDeleteProvider>{null}</LogbookDeleteProvider>);
    await act(() => vi.advanceTimersByTimeAsync(LOGBOOK_DELETE_UNDO_MS - 1));
    expect(state.mutation).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(state.mutation).toHaveBeenCalledExactlyOnceWith('tick');
    expect(state.track).toHaveBeenCalledWith('Logbook Entry Deleted', { method: 'a11y', viaChooser: false });
  });
  it('cancels pending deletion on scope change and reports that the entry was kept', async () => {
    const screen = render(
      <LogbookDeleteProvider>
        <Route />
      </LogbookDeleteProvider>,
    );
    act(() => {
      actions.scheduleDelete({ originScope: 'account:board', uuid: 'tick', method: 'swipe' });
    });
    state.scope = 'other-account:other-board';
    screen.rerender(
      <LogbookDeleteProvider>
        <Route />
      </LogbookDeleteProvider>,
    );
    expect(hidden.has('tick')).toBe(false);
    expect(state.toast).toHaveBeenCalledWith('undoDelete.cancelled', 'info');
    await act(() => vi.advanceTimersByTimeAsync(LOGBOOK_DELETE_UNDO_MS));
    expect(state.mutation).not.toHaveBeenCalled();
  });
  it('rejects confirmation from an account or board that changed before scheduling', () => {
    state.scope = 'new-scope';
    render(
      <LogbookDeleteProvider>
        <Route />
      </LogbookDeleteProvider>,
    );
    act(() => {
      expect(actions.scheduleDelete({ originScope: 'old-scope', uuid: 'tick', method: 'swipe' })).toBe(false);
    });
    expect(hidden.size).toBe(0);
    expect(state.mutation).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith('undoDelete.cancelled', 'info');
  });
  it('restores a failed entry and sends one error toast', async () => {
    state.mutation.mockRejectedValueOnce(new Error('offline'));
    render(
      <LogbookDeleteProvider>
        <Route />
      </LogbookDeleteProvider>,
    );
    const settled = vi.fn();
    act(() => {
      actions.scheduleDelete({ originScope: 'account:board', uuid: 'tick', method: 'swipe', onSettled: settled });
    });
    await act(() => vi.advanceTimersByTimeAsync(LOGBOOK_DELETE_UNDO_MS));
    expect(hidden.has('tick')).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledExactlyOnceWith('mobile.logbook.deleteError', 'error');
    expect(state.track).not.toHaveBeenCalled();
  });
});
