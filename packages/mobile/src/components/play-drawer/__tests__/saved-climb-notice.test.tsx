// @vitest-environment jsdom
//
// The play drawer's "Saved" line after a heart (#6002). The copy is the en-US
// catalog itself, so a renamed or missing key fails here instead of rendering a
// raw key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import sessionCatalog from '@boardsesh/i18n/locales/en-US/session.json';
import type { SavedClimbNoticeHandle } from '../SavedClimbNotice';

type Children = { children?: ReactNode };

const trackMock = vi.hoisted(() => vi.fn());
const storeCtrl = vi.hoisted(() => ({ showsLeft: 3, ensureLoaded: vi.fn() }));
const flagsCtrl = vi.hoisted(() => ({ enabled: true }));
const deviceCtrl = vi.hoisted(() => ({ device: null as { connectedAt: number | null } | null }));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
      createElement('div', { role: accessibilityRole }, children),
  },
  FadeInDown: { duration: () => ({}) },
  FadeOutDown: { duration: () => ({}) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          sessionCatalog,
        );
      return typeof found === 'string' ? found : key;
    },
  }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/onboarding/first-connect-store', () => ({
  getFirstConnectSnapshot: () => ({ device: deviceCtrl.device }),
}));
vi.mock('../../../lib/save-next-session/save-next-session-store', () => ({
  ensureSaveNextSessionLoaded: storeCtrl.ensureLoaded,
  claimSavedClimbNoticeShow: () => {
    if (storeCtrl.showsLeft <= 0) return false;
    storeCtrl.showsLeft -= 1;
    return true;
  },
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useSaveNextSessionEnabled: () => flagsCtrl.enabled,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'liquidGlass',
    systemColors: { label: '#000', secondaryBackground: '#eee' },
    brandColors: { primary: '#6D28D9' },
    m3SurfaceContainers: { high: '#ddd' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { lg: 12 },
  shadowColor: '#000',
  spacing: { 2: 8, 3: 12, 4: 16 },
}));

const { SavedClimbNotice } = await import('../SavedClimbNotice');

const SAVED_FOR_NEXT = 'Saved for your next session';
const SAVED_CONNECTED = 'Saved to Liked Climbs';
const FAVORITE_ERROR = "Couldn't update your favorites — try again";

function renderNotice(climbUuid = 'climb-1') {
  const ref = createRef<SavedClimbNoticeHandle>();
  const onView = vi.fn();
  const view = render(<SavedClimbNotice ref={ref} climbUuid={climbUuid} onView={onView} />);
  const handle = (): SavedClimbNoticeHandle => {
    if (!ref.current) throw new Error('notice not mounted');
    return ref.current;
  };
  return { ...view, handle, onView };
}

describe('SavedClimbNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storeCtrl.showsLeft = 3;
    storeCtrl.ensureLoaded.mockClear();
    flagsCtrl.enabled = true;
    deviceCtrl.device = { connectedAt: null };
    trackMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows nothing until a heart is added, and reads the cap up front', () => {
    const { container } = renderNotice();

    expect(container.textContent).toBe('');
    expect(storeCtrl.ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it('says the climb is kept for the next session when no board is connected', () => {
    const { handle } = renderNotice();

    act(() => handle().showSaved(false));

    expect(screen.getByText(SAVED_FOR_NEXT)).toBeTruthy();
    expect(screen.getByLabelText('View saved climbs')).toBeTruthy();
    expect(trackMock).toHaveBeenCalledWith('Save Prompt Shown', {
      source: 'play_drawer_heart',
      connected: false,
      phone_has_connected: false,
    });
  });

  it('names the list instead while this phone is connected to a board', () => {
    deviceCtrl.device = { connectedAt: 5 };
    const { handle } = renderNotice();

    act(() => handle().showSaved(true));

    expect(screen.getByText(SAVED_CONNECTED)).toBeTruthy();
    expect(screen.queryByText(SAVED_FOR_NEXT)).toBeNull();
    expect(trackMock).toHaveBeenCalledWith('Save Prompt Shown', {
      source: 'play_drawer_heart',
      connected: true,
      phone_has_connected: true,
    });
  });

  it('reports an unread connect history as unknown, not as never connected', () => {
    deviceCtrl.device = null;
    const { handle } = renderNotice();

    act(() => handle().showSaved(false));

    expect(trackMock).toHaveBeenCalledWith('Save Prompt Shown', expect.objectContaining({ phone_has_connected: null }));
  });

  it('leaves the player for the liked list on View, and logs the tap', () => {
    const { handle, onView, container } = renderNotice();
    act(() => handle().showSaved(false));

    fireEvent.click(screen.getByLabelText('View saved climbs'));

    expect(onView).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Save Prompt Tapped', { source: 'play_drawer_heart', connected: false });
    expect(container.textContent).toBe('');
  });

  it('goes away by itself after four seconds, and a second heart restarts the clock', () => {
    const { handle, container } = renderNotice();

    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });

    act(() => handle().showSaved(false));
    advance(3000);
    act(() => handle().showSaved(false));
    advance(3000);
    expect(screen.getByText(SAVED_FOR_NEXT)).toBeTruthy();

    advance(1000);
    expect(container.textContent).toBe('');
  });

  it('leaves nothing behind when the drawer closes with the four seconds still running', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handle, unmount, onView } = renderNotice();

    act(() => handle().showSaved(false));
    expect(vi.getTimerCount()).toBe(1);
    trackMock.mockClear();

    unmount();
    // The pending auto-dismiss went with the component, so nothing is left that
    // could set state on it later.
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);

    // And nothing fired: no React complaint, no callback, no event.
    expect(consoleError).not.toHaveBeenCalled();
    expect(onView).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('stops after the phone has used its three shows, and clears a stale line', () => {
    storeCtrl.showsLeft = 1;
    const { handle, container } = renderNotice();

    act(() => handle().showSaved(false));
    expect(screen.getByText(SAVED_FOR_NEXT)).toBeTruthy();

    act(() => handle().showSaved(false));
    expect(container.textContent).toBe('');
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('comes down when the heart is removed', () => {
    const { handle, container } = renderNotice();
    act(() => handle().showSaved(false));

    act(() => handle().hide());

    expect(container.textContent).toBe('');
  });

  it('does not ride onto the next climb', () => {
    const ref = createRef<SavedClimbNoticeHandle>();
    const { rerender, container } = render(<SavedClimbNotice ref={ref} climbUuid="climb-1" onView={vi.fn()} />);
    act(() => ref.current?.showSaved(false));
    expect(screen.getByText(SAVED_FOR_NEXT)).toBeTruthy();

    rerender(<SavedClimbNotice ref={ref} climbUuid="climb-2" onView={vi.fn()} />);

    expect(container.textContent).toBe('');
  });

  it('carries the failed-heart line inline, with no View and no show spent', () => {
    storeCtrl.showsLeft = 0;
    const { handle } = renderNotice();

    let shown = false;
    act(() => {
      shown = handle().showError();
    });

    expect(shown).toBe(true);
    expect(screen.getByText(FAVORITE_ERROR)).toBeTruthy();
    expect(screen.queryByLabelText('View saved climbs')).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  describe('with the kill switch on', () => {
    beforeEach(() => {
      flagsCtrl.enabled = false;
    });

    it('shows no Saved line and spends no show', () => {
      const { handle, container } = renderNotice();

      act(() => handle().showSaved(false));

      expect(container.textContent).toBe('');
      expect(storeCtrl.showsLeft).toBe(3);
      expect(trackMock).not.toHaveBeenCalled();
    });

    it('hands the error back to the caller, which still has its toast', () => {
      const { handle, container } = renderNotice();

      let shown = true;
      act(() => {
        shown = handle().showError();
      });

      expect(shown).toBe(false);
      expect(container.textContent).toBe('');
    });
  });
});
