// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

// Capture what ClimbReactionMenu passes into useClimbActions (so we can assert the
// playlist action is wired to the inline view switch) and what the picker gets.
const captured = vi.hoisted(() => ({
  actionArgs: null as Record<string, unknown> | null,
  pickerOnBack: undefined as undefined | (() => void),
  pickerOnDetachedFailure: undefined as undefined | ((message: string) => void),
  modalOnRequestClose: undefined as undefined | (() => void),
  boardImageProps: null as Record<string, unknown> | null,
  ran: undefined as undefined | string,
  glassSurfaceProps: null as Record<string, unknown> | null,
  fadeColors: null as readonly string[] | null,
}));

const showToast = vi.hoisted(() => vi.fn());

// Drives the rendering branches: which material sits under the overlay, which
// scheme, and how tall the window is (a short window forces the action list to
// scroll, which is what mounts the bottom fade).
const ctrl = vi.hoisted(() => ({
  surfaceMode: 'material' as string,
  colorScheme: 'dark' as 'dark' | 'light',
  windowHeight: 800,
}));

vi.mock('react-native', async () => {
  // Dynamic import: Vitest hoists this factory above the file's imports.
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
    Keyboard: { addListener: () => ({ remove: () => {} }) },
    Modal: ({ children, onRequestClose }: { children?: ReactNode; onRequestClose?: () => void }) => {
      captured.modalOnRequestClose = onRequestClose;
      return createElement('div', { 'data-modal': 'true' }, children);
    },
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
    }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
    ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    TextInput: () => null,
    View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
      createElement('div', { 'data-bg': flattenStyle(style).backgroundColor }, children),
    StyleSheet: {
      create: (s: Record<string, unknown>) => s,
      absoluteFill: {},
      hairlineWidth: 1,
      flatten: flattenStyle,
    },
    PixelRatio: { get: () => 2 },
    useWindowDimensions: () => ({ width: 400, height: ctrl.windowHeight, fontScale: 1 }),
  };
});

vi.mock('react-native-reanimated', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    default: {
      View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
        createElement('div', { 'data-bg': flattenStyle(style).backgroundColor }, children),
    },
    useAnimatedStyle: () => ({}),
    useSharedValue: (v: number) => ({ value: v }),
    withSpring: (v: number) => v,
    withTiming: (v: number) => v,
    runOnJS: (fn: () => void) => fn,
  };
});

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ colors }: { colors?: readonly string[] }) => {
    captured.fadeColors = colors ?? null;
    return createElement('div', { 'data-testid': 'menu-fade' });
  },
}));
vi.mock('../../../hooks/use-effective-surface-mode', () => ({
  useEffectiveSurfaceMode: () => ctrl.surfaceMode,
}));
vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#fff',
  DEFAULT_GRADE_COLOR: '#fff',
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'aria-label': title, 'data-listrow': 'true' }, title),
}));
// Records the surface contract (role / level / clip) rather than throwing it away:
// the card's M3 tone and elevation cast are exactly what this component sets.
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => {
    captured.glassSurfaceProps = props;
    return createElement('div', { 'data-glass': 'true' }, children);
  },
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: Record<string, unknown>) => {
    captured.boardImageProps = props;
    return null;
  },
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../playlist/InlinePlaylistPicker', () => ({
  InlinePlaylistPicker: ({
    onBack,
    onDetachedFailure,
  }: {
    onBack?: () => void;
    onDetachedFailure?: (message: string) => void;
  }) => {
    captured.pickerOnBack = onBack;
    captured.pickerOnDetachedFailure = onDetachedFailure;
    return createElement('div', { 'data-picker': 'true' }, 'picker');
  },
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../lib/board-details', () => ({
  getBoardRenderData: () => ({ boardWidth: 120, boardHeight: 120 }),
}));
vi.mock('../../../lib/format-climb-stats', () => ({ formatSends: () => '', formatQuality: () => '' }));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: () => 'V4' }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: ctrl.colorScheme,
    systemColors: { fill: '#222', label: '#fff' },
    m3SurfaceContainers: { lowest: '#101018', low: '#202028', base: '#303038', high: '#404048', highest: '#505058' },
  }),
}));
vi.mock('../../../theme/animations', () => ({ springs: { gentle: {} }, timing: { fast: 150 } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 5: 20, 6: 24 },
  borderRadius: { lg: 12, xl: 16 },
}));
// Tagged rather than re-implemented: the assertions care that the fade is built
// from the card's own tone, not that we can redo hex→rgba arithmetic in a test.
vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `alpha(${color}, ${alpha})`,
}));

// The playlist action's run() calls onSelectPlaylist (mirroring the real hook), so
// tapping it drives the view switch we want to test.
vi.mock('../use-climb-actions', () => ({
  useClimbActions: (args: Record<string, unknown>) => {
    captured.actionArgs = args;
    return [
      { id: 'preview', title: 'Preview', icon: 'visibility', color: '#00f', run: () => {} },
      { id: 'tick', title: 'Log a tick', icon: 'tick', color: '#0f0', run: () => (captured.ran = 'tick') },
      {
        id: 'playlist',
        title: 'Add to Playlist',
        icon: 'playlist',
        color: '#00f',
        run: () => (args.onSelectPlaylist as (() => void) | undefined)?.(),
      },
      { id: 'favorite', title: 'Favorite', icon: 'favorite', color: '#f00', run: () => {} },
      { id: 'share', title: 'Share', icon: 'share', color: '#00f', run: () => (captured.ran = 'share') },
    ];
  },
}));

import { ClimbReactionMenu } from '../ClimbReactionMenu';

const climb = { uuid: 'climb-1', name: 'Big Move', frames: '', difficulty: 'V4', quality_average: '0' } as Climb;
const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

function renderMenu(onClose = vi.fn(), extraProps: Record<string, unknown> = {}) {
  return {
    onClose,
    ...render(
      <ClimbReactionMenu
        climb={climb}
        boardConfig={boardConfig as never}
        isAuthenticated
        reduceMotion
        onClose={onClose}
        {...extraProps}
      />,
    ),
  };
}

describe('ClimbReactionMenu view switching', () => {
  beforeEach(() => {
    captured.actionArgs = null;
    captured.pickerOnBack = undefined;
    captured.pickerOnDetachedFailure = undefined;
    captured.modalOnRequestClose = undefined;
    showToast.mockReset();
    captured.boardImageProps = null;
    captured.ran = undefined;
    captured.glassSurfaceProps = null;
    captured.fadeColors = null;
    ctrl.surfaceMode = 'material';
    ctrl.colorScheme = 'dark';
    ctrl.windowHeight = 800;
  });

  it('runs the action when a primary button is pressed', () => {
    const { getByLabelText } = renderMenu();
    act(() => fireEvent.click(getByLabelText('Log a tick')));
    expect(captured.ran).toBe('tick');
    act(() => fireEvent.click(getByLabelText('Share')));
    expect(captured.ran).toBe('share');
  });

  it('renders the board at play-drawer quality (full background, DPR overlay, outlined holds)', () => {
    renderMenu();
    const props = captured.boardImageProps;
    expect(props).not.toBeNull();
    // Full-resolution board photo (not the 416px thumbnail).
    expect(props?.backgroundVariant).toBe('full');
    // Outlined holds like the play drawer, not the filled-dot thumbnail style.
    expect(props?.filledStyle).toBeUndefined();
    // Overlay rasterized at the displayed width × DPR (PixelRatio.get() → 2 here).
    expect(typeof props?.renderWidth).toBe('number');
    expect(props?.renderWidth as number).toBeGreaterThan(0);
  });

  it('pulls tick, playlist and share into the primary button row and leaves the rest in the list', () => {
    const { getByLabelText, container } = renderMenu();

    // All five actions render.
    for (const label of ['Log a tick', 'Add to Playlist', 'Share', 'Preview', 'Favorite']) {
      expect(getByLabelText(label)).not.toBeNull();
    }

    // The three primary actions are NOT list rows (they're the button row); the
    // remainder are.
    for (const label of ['Log a tick', 'Add to Playlist', 'Share']) {
      expect(container.querySelector(`[data-listrow="true"][aria-label="${label}"]`)).toBeNull();
    }
    for (const label of ['Preview', 'Favorite']) {
      expect(container.querySelector(`[data-listrow="true"][aria-label="${label}"]`)).not.toBeNull();
    }
  });

  it('renders the action list first and swaps to the inline picker when the playlist action runs', () => {
    const { getByLabelText, queryByLabelText, container } = renderMenu();
    // Menu view: actions present, no picker.
    expect(getByLabelText('Add to Playlist')).not.toBeNull();
    expect(container.querySelector('[data-picker="true"]')).toBeNull();

    // Tapping the playlist action → onSelectPlaylist → view 'playlist'.
    act(() => {
      fireEvent.click(getByLabelText('Add to Playlist'));
    });
    expect(container.querySelector('[data-picker="true"]')).not.toBeNull();
    expect(queryByLabelText('Add to Playlist')).toBeNull();
  });

  it('forwards the onAddBetaVideo override into useClimbActions', () => {
    const onAddBetaVideo = vi.fn();
    renderMenu(vi.fn(), { onAddBetaVideo });
    expect(captured.actionArgs?.onAddBetaVideo).toBe(onAddBetaVideo);
  });

  it('forwards the onReportClimb override into useClimbActions', () => {
    const onReportClimb = vi.fn();
    renderMenu(vi.fn(), { onReportClimb });
    expect(captured.actionArgs?.onReportClimb).toBe(onReportClimb);
  });

  // A climb the crew voted down still opens from a queue item or a shared link,
  // and this byline is the only place that says so.
  it('marks a community-hidden climb in the byline', () => {
    const hiddenClimb = { ...climb, setter_username: 'nate', is_hidden: true } as Climb;
    const { getByText } = renderMenu(vi.fn(), { climb: hiddenClimb });
    expect(getByText('nate · mobile.hidden.short')).not.toBeNull();
  });

  it('leaves the byline alone for a climb nobody has hidden', () => {
    const visibleClimb = { ...climb, setter_username: 'nate' } as Climb;
    const { getByText, queryByText } = renderMenu(vi.fn(), { climb: visibleClimb });
    expect(queryByText('nate · mobile.hidden.short')).toBeNull();
    expect(getByText('nate')).not.toBeNull();
  });

  it('returns to the action list when the picker calls onBack', () => {
    const { getByLabelText, container } = renderMenu();
    act(() => fireEvent.click(getByLabelText('Add to Playlist')));
    expect(container.querySelector('[data-picker="true"]')).not.toBeNull();

    act(() => captured.pickerOnBack?.());
    expect(container.querySelector('[data-picker="true"]')).toBeNull();
    expect(getByLabelText('Add to Playlist')).not.toBeNull();
  });

  // #3891. Back-to-menu unmounts the picker while this overlay is still presented,
  // so "the picker is gone" does NOT mean "a toast is visible" — a root toast
  // renders behind the FullWindowOverlay / Modal and self-dismisses in 3s. The
  // overlay takes the message and fires it on the way out instead.
  it('holds a detached playlist failure until the overlay itself is gone, then toasts it', () => {
    const { getByLabelText, unmount } = renderMenu();
    act(() => fireEvent.click(getByLabelText('Add to Playlist')));
    expect(captured.pickerOnDetachedFailure).toBeTypeOf('function');

    // The add rejects after back-to-menu: picker unmounted, overlay still up.
    act(() => captured.pickerOnBack?.());
    act(() => captured.pickerOnDetachedFailure?.("Couldn't add to Minimoon circuit"));
    expect(showToast).not.toHaveBeenCalled();

    unmount();
    expect(showToast).toHaveBeenCalledWith("Couldn't add to Minimoon circuit", 'error');
  });

  it('does not toast on dismissal when no playlist failure was handed over', () => {
    const { getByLabelText, unmount } = renderMenu();
    act(() => fireEvent.click(getByLabelText('Add to Playlist')));
    act(() => captured.pickerOnBack?.());
    unmount();
    expect(showToast).not.toHaveBeenCalled();
  });

  // The other order, and the one that used to lose the message: the climber
  // dismisses the whole overlay while the add is still in flight. Cleanup has
  // already run by the time the rejection lands, so there is no later flush to
  // ride out on — the message has to toast the moment it arrives.
  it('toasts immediately when the failure lands after the overlay is already gone', () => {
    const { getByLabelText, unmount } = renderMenu();
    act(() => fireEvent.click(getByLabelText('Add to Playlist')));
    const reportDetachedFailure = captured.pickerOnDetachedFailure;
    expect(reportDetachedFailure).toBeTypeOf('function');

    unmount();
    expect(showToast).not.toHaveBeenCalled();

    act(() => reportDetachedFailure?.("Couldn't add to Minimoon circuit"));
    expect(showToast).toHaveBeenCalledWith("Couldn't add to Minimoon circuit", 'error');
  });

  it('hardware back dismisses from the menu but only pops the picker from the playlist view', () => {
    const { getByLabelText, onClose, container } = renderMenu();

    // From the playlist view, back pops to the menu without dismissing.
    act(() => fireEvent.click(getByLabelText('Add to Playlist')));
    act(() => captured.modalOnRequestClose?.());
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-picker="true"]')).toBeNull();

    // From the menu, back dismisses the whole overlay (reduceMotion → immediate).
    act(() => captured.modalOnRequestClose?.());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('labels the tap-to-dismiss scrim as a close control, not as the climb', () => {
    const { queryByLabelText, onClose } = renderMenu();
    // The climb name would make VoiceOver/TalkBack announce a climb for a button
    // that closes the overlay.
    expect(queryByLabelText('Big Move')).toBeNull();
    const scrim = queryByLabelText('mobile.climbActions.closeOverlay');
    expect(scrim).not.toBeNull();
    act(() => fireEvent.click(scrim as Element));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// The overlay is an M3 dialog: a modal, scrim-dimming, non-anchored card. On the
// no-blur paths nothing recedes the board-art grid behind it but the scrim itself.
describe('ClimbReactionMenu surface treatment', () => {
  beforeEach(() => {
    captured.glassSurfaceProps = null;
    captured.fadeColors = null;
    ctrl.surfaceMode = 'material';
    ctrl.colorScheme = 'dark';
    ctrl.windowHeight = 800;
  });

  it('raises the card to the M3 dialog tone and cast', () => {
    renderMenu();
    expect(captured.glassSurfaceProps?.role).toBe('high');
    expect(captured.glassSurfaceProps?.level).toBe('level3');
  });

  it('keeps the card clipped so the fade and the picker header stay inside the corners', () => {
    renderMenu();
    // GlassSurface hoists this clip off its elevated view, so asking for it no
    // longer costs the Android cast.
    expect((captured.glassSurfaceProps?.style as Record<string, unknown>)?.overflow).toBe('hidden');
  });

  it('paints the backdrop AND the board-art wrapper with the card tone on Material', () => {
    ctrl.surfaceMode = 'material';
    const { container } = renderMenu();
    // m3SurfaceContainers.high — the same tone the card itself is raised to.
    // Both the full-screen backdrop and the board-art wrapper paint it, so at
    // least two elements should carry it.
    expect(container.querySelectorAll('[data-bg="#404048"]').length).toBeGreaterThanOrEqual(2);
  });

  it("paints the backdrop with the card's opaque glass base off Material, by scheme", () => {
    for (const mode of ['glass', 'blur', 'solid']) {
      ctrl.surfaceMode = mode;
      ctrl.colorScheme = 'dark';
      const dark = renderMenu();
      expect(dark.container.querySelector('[data-bg="rgb(20, 17, 31)"]')).not.toBeNull();

      ctrl.colorScheme = 'light';
      const light = renderMenu();
      expect(light.container.querySelector('[data-bg="rgb(255, 255, 255)"]')).not.toBeNull();
    }
  });

  it('builds the list fade from the very tone the card is painted with on Material', () => {
    // Short window → the list is capped and scrolls, which mounts the fade.
    ctrl.windowHeight = 200;
    const { container } = renderMenu();
    expect(container.querySelector('[data-testid="menu-fade"]')).not.toBeNull();
    const cardTone = { lowest: '#101018', low: '#202028', base: '#303038', high: '#404048', highest: '#505058' }[
      captured.glassSurfaceProps?.role as string
    ];
    expect(captured.fadeColors).toEqual([`alpha(${cardTone}, 0)`, `alpha(${cardTone}, 0.92)`]);
  });

  it('keeps the tuned constants for the fade on the glass path (no opaque tone to read)', () => {
    ctrl.surfaceMode = 'glass';
    ctrl.windowHeight = 200;
    renderMenu();
    expect(captured.fadeColors).toEqual(['rgba(20, 17, 31, 0)', 'rgba(20, 17, 31, 0.92)']);
  });
});
