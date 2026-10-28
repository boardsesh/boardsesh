// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  localConnected: false,
  bluetooth: { boardName: 'kilter', layoutId: 8, sizeId: 17 } as {
    boardName: string | undefined;
    layoutId?: number;
    sizeId?: number;
  } | null,
  lightbulbOptions: null as Record<string, unknown> | null,
  snackbar: null as Record<string, unknown> | null,
  os: 'ios',
}));

vi.mock('../../components/ble/use-lightbulb-control', () => ({
  useLightbulbControl: (options: Record<string, unknown>) => {
    state.lightbulbOptions = options;
    return { connect: state.connect, localConnected: state.localConnected, bluetooth: state.bluetooth };
  },
}));
vi.mock('../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ floatingControlBottom: 10 }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { absoluteFill: {} },
}));
vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-overlay': true }, children),
}));
vi.mock('react-native-paper', () => ({
  Portal: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-portal': true }, children),
}));
vi.mock('../../components/UndoSnackbar', () => ({
  UndoSnackbar: (props: Record<string, unknown>) => {
    state.snackbar = props;
    return createElement('span', null, String(props.message));
  },
}));

import { BoardDisconnectUndoProvider } from '../board-disconnect-undo-provider';
import { useBoardDisconnectUndo, type BoardDisconnectUndoActions } from '../../components/ble/board-disconnect-undo';

let actions: BoardDisconnectUndoActions | null = null;
function Bulb() {
  actions = useBoardDisconnectUndo();
  return null;
}

const tree = () => (
  <BoardDisconnectUndoProvider>
    <Bulb />
  </BoardDisconnectUndoProvider>
);

function callSnackbar(handler: 'onUndo' | 'onDismiss') {
  const callback = state.snackbar?.[handler];
  if (typeof callback !== 'function') throw new Error(`no snackbar ${handler}`);
  (callback as () => void)();
}

const offer = {
  surface: 'board_control_indicator' as const,
  placement: 'inline' as const,
  target: { serial: 'serial-1' },
  boardKey: 'kilter:8:17',
};

beforeEach(() => {
  state.connect.mockReset().mockResolvedValue(true);
  state.localConnected = false;
  state.bluetooth = { boardName: 'kilter', layoutId: 8, sizeId: 17 };
  state.lightbulbOptions = null;
  state.snackbar = null;
  state.os = 'ios';
  actions = null;
});

describe('BoardDisconnectUndoProvider (#6940)', () => {
  it('shows nothing until a bulb disconnects', () => {
    const { container } = render(tree());
    expect(container.textContent).toBe('');
    expect(state.snackbar).toBeNull();
  });

  it('shows Board disconnected above the player modal on iOS, and Undo reconnects the same board', () => {
    const { container } = render(tree());
    act(() => actions?.offerUndo(offer));

    expect(container.textContent).toBe('ble.barControl.disconnectedLabel');
    expect(container.querySelector('[data-overlay]')).not.toBeNull();
    expect(state.snackbar).toMatchObject({
      undoLabel: 'mobile.boardPresence.undo',
      undoAccessibilityLabel: 'ble.barControl.undoDisconnectAria',
    });
    // The bulb's own connect, scoped to the bulb that disconnected.
    expect(state.lightbulbOptions).toEqual({ surface: 'board_control_indicator', placement: 'inline' });

    act(() => callSnackbar('onUndo'));
    expect(state.connect).toHaveBeenCalledExactlyOnceWith('board_control_indicator', {
      target: { serial: 'serial-1' },
      placement: 'inline',
      undo: true,
    });
    expect(container.textContent).toBe('');
  });

  it('uses the Paper portal on Android', () => {
    state.os = 'android';
    const { container } = render(tree());
    act(() => actions?.offerUndo(offer));
    expect(container.querySelector('[data-portal]')).not.toBeNull();
  });

  it('goes away when it times out, without reconnecting', () => {
    const { container } = render(tree());
    act(() => actions?.offerUndo(offer));
    act(() => callSnackbar('onDismiss'));
    expect(container.textContent).toBe('');
    expect(state.connect).not.toHaveBeenCalled();
  });

  it('waits for the link to drop, then goes away when it comes back some other way', () => {
    // The offer can mount on the render before the disconnect lands.
    state.localConnected = true;
    const screen = render(tree());
    act(() => actions?.offerUndo(offer));
    expect(screen.container.textContent).toBe('ble.barControl.disconnectedLabel');

    state.localConnected = false;
    screen.rerender(tree());
    expect(screen.container.textContent).toBe('ble.barControl.disconnectedLabel');

    state.localConnected = true;
    screen.rerender(tree());
    expect(screen.container.textContent).toBe('');
  });

  it('goes away when the climber moves to another board', () => {
    const screen = render(tree());
    act(() => actions?.offerUndo(offer));
    state.bluetooth = { boardName: 'kilter', layoutId: 8, sizeId: 25 };
    screen.rerender(tree());
    expect(screen.container.textContent).toBe('');
    expect(state.connect).not.toHaveBeenCalled();
  });
});
