// @vitest-environment jsdom
import React, {
  createElement,
  createRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayDrawerMenuRow } from '../../play-drawer/play-drawer-menu-rows';
import type { ClimbListRowMenuHandle } from '../ClimbListRowMenu.types';

type MeasureCallback = (x: number, y: number, width: number, height: number) => void;
type MeasureHandle = { measureInWindow: (callback: MeasureCallback) => void };
type ViewProps = {
  ref?: Ref<MeasureHandle>;
  children?: ReactNode;
  testID?: string;
  style?: unknown;
  accessibilityLabel?: string;
  accessibilityRole?: string;
};
type PressProps = Omit<ViewProps, 'ref'> & {
  ref?: Ref<HTMLButtonElement>;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityState?: { disabled?: boolean; selected?: boolean };
};

const runtime = vi.hoisted(() => ({
  generation: 0,
  credentialListeners: new Set<() => void>(),
  measurements: [] as MeasureCallback[],
  animations: [] as ((finished: boolean) => void)[],
  frames: new Map<number, FrameRequestCallback>(),
  nextFrame: 1,
  viewport: { width: 402, height: 874, scale: 3, fontScale: 1 },
  mountedBodies: 0,
  maximumMountedBodies: 0,
  haptic: vi.fn(),
  focus: vi.fn(),
  dismissKeyboard: vi.fn(),
}));

function MockView({ ref, children, testID, style, accessibilityLabel, accessibilityRole }: ViewProps) {
  useImperativeHandle(
    ref,
    () => ({ measureInWindow: (callback: MeasureCallback) => runtime.measurements.push(callback) }),
    [],
  );
  return createElement(
    'div',
    {
      'data-testid': testID,
      'data-style': JSON.stringify(style),
      'aria-label': accessibilityLabel,
      role: accessibilityRole === 'header' ? 'heading' : undefined,
    },
    children,
  );
}

vi.mock('react-native', () => ({
  View: MockView,
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: { position: 'absolute' } },
  Dimensions: { get: () => ({ ...runtime.viewport }) },
  useWindowDimensions: () => runtime.viewport,
  // A rendered button reports its label, so a test can tell which control got
  // focus back; the row body's ref is never attached here.
  findNodeHandle: (instance: unknown) => (instance instanceof HTMLElement ? instance.getAttribute('aria-label') : 42),
  Keyboard: { dismiss: runtime.dismissKeyboard },
  AccessibilityInfo: { setAccessibilityFocus: runtime.focus },
  FlatList: ({
    data,
    renderItem,
    testID,
  }: {
    data: PlayDrawerMenuRow[];
    renderItem: (input: { item: PlayDrawerMenuRow; index: number }) => ReactNode;
    testID: string;
  }) =>
    createElement(
      'div',
      { 'data-testid': testID },
      data.map((item, index) => createElement(React.Fragment, { key: item.id }, renderItem({ item, index }))),
    ),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: MockView },
  runOnJS: <Callback extends (...args: never[]) => unknown>(callback: Callback) => callback,
  useSharedValue: (initial: number) => useRef({ value: initial }).current,
  useAnimatedStyle: (style: () => unknown) => style(),
  withSpring: (target: number) => target,
  withTiming: (target: number, _options: unknown, complete: (finished: boolean) => void) => {
    runtime.animations.push(complete);
    return target;
  },
}));
vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-testid': 'full-window-overlay' }, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('expo-symbols', () => ({
  SymbolView: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getCredentialGeneration: () => runtime.generation,
  subscribeToCredentialChanges: (listener: () => void) => {
    runtime.credentialListeners.add(listener);
    return () => runtime.credentialListeners.delete(listener);
  },
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: runtime.haptic }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: 'black',
      error: 'red',
      separator: 'gray',
      tertiaryBackground: 'gray',
      elevatedSurface: 'white',
    },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  cardCorners: { borderRadius: 12 },
  overlays: { scrim: 'black' },
  shadows: { xl: {}, lg: {} },
  spacing: { 3: 12, 4: 16 },
}));
vi.mock('../../../theme/animations', () => ({ springs: { gentle: {} }, timing: { fast: 180 } }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i') }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  StaticPressableSurface: ({
    ref,
    children,
    onPress,
    disabled,
    testID,
    accessibilityLabel,
    accessibilityState,
  }: PressProps) =>
    createElement(
      'button',
      {
        ref,
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        'aria-disabled': accessibilityState?.disabled,
        'aria-pressed': accessibilityState?.selected,
        disabled,
        onClick: onPress,
      },
      children,
    ),
}));
vi.mock('../../play-drawer/use-announce-body-focus', () => ({ useAnnounceBodyFocus: vi.fn() }));
vi.mock('../ClimbListRowMenu.fallback', () => ({
  FallbackClimbListRowMenu: () => createElement('div', { 'data-testid': 'fallback-menu' }),
}));

import { ClimbListRowMenu } from '../ClimbListRowMenu.ios';

function RowBody({ title }: { title: string }) {
  useEffect(() => {
    runtime.mountedBodies++;
    runtime.maximumMountedBodies = Math.max(runtime.maximumMountedBodies, runtime.mountedBodies);
    return () => {
      runtime.mountedBodies--;
    };
  }, []);
  return <span data-testid="row-body">{title}</span>;
}

function Harness({
  menuRef,
  menuKey = 'climb-a',
  title = 'Rocky',
  rows,
  onBeforeOpen,
}: {
  menuRef?: Ref<ClimbListRowMenuHandle>;
  menuKey?: string;
  title?: string;
  rows: PlayDrawerMenuRow[];
  onBeforeOpen?: () => void;
}) {
  const focusRef = useRef(null);
  return (
    <ClimbListRowMenu
      ref={menuRef}
      enabled
      rows={rows}
      menuKey={menuKey}
      title={title}
      accessibilityLabel={`More ${title}`}
      focusRef={focusRef}
      bodyStyle={{ flex: 1 }}
      moreButtonStyle={{ width: 44 }}
      showMoreButton
      onBeforeOpen={onBeforeOpen}
      preview={<RowBody title={title} />}
    >
      <RowBody title={title} />
    </ClimbListRowMenu>
  );
}

function actionRows(run: (id: string) => void = vi.fn()): PlayDrawerMenuRow[] {
  return [
    { id: 'playNext', label: 'Play next', run: () => run('playNext') },
    { id: 'share', label: 'Share', run: () => run('share'), dividerBefore: true },
    { id: 'favorite', label: 'Favorite', run: () => run('favorite'), disabled: true },
  ];
}

function measureNext() {
  completeFrames();
  const callback = runtime.measurements.shift();
  expect(callback).toBeDefined();
  act(() => callback?.(16, 500, 326, 96));
}

function completeAnimations() {
  act(() => {
    const animations = runtime.animations.splice(0);
    for (const complete of animations) complete(true);
  });
}

function completeFrames() {
  act(() => {
    const frames = [...runtime.frames.values()];
    runtime.frames.clear();
    for (const frame of frames) frame(0);
  });
}

function changeCredentials() {
  act(() => {
    runtime.generation++;
    for (const listener of runtime.credentialListeners) listener();
  });
}

beforeEach(() => {
  runtime.generation = 0;
  runtime.credentialListeners.clear();
  runtime.measurements = [];
  runtime.animations = [];
  runtime.frames.clear();
  runtime.nextFrame = 1;
  runtime.viewport = { width: 402, height: 874, scale: 3, fontScale: 1 };
  runtime.mountedBodies = 0;
  runtime.maximumMountedBodies = 0;
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = runtime.nextFrame++;
    runtime.frames.set(frame, callback);
    return frame;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => runtime.frames.delete(frame));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('lifted climb list row menu', () => {
  it('uses the same lifted preview and actions for ellipsis taps and imperative opens', () => {
    const menuRef = createRef<ClimbListRowMenuHandle>();
    const onBeforeOpen = vi.fn(() => expect(runtime.measurements).toHaveLength(0));
    render(<Harness menuRef={menuRef} rows={actionRows()} onBeforeOpen={onBeforeOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    expect(onBeforeOpen).toHaveBeenCalledTimes(1);
    expect(runtime.measurements).toHaveLength(0);
    measureNext();
    const tappedPreview = screen.getByTestId('climb-row-menu-preview').getAttribute('data-style');
    const tappedActions = screen.getByTestId('climb-row-menu-actions').textContent;
    expect(screen.getByRole('heading', { name: 'Rocky' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('climb-row-menu-backdrop'));
    completeAnimations();
    completeFrames();

    act(() => menuRef.current?.open());
    expect(onBeforeOpen).toHaveBeenCalledTimes(2);
    expect(runtime.measurements).toHaveLength(0);
    measureNext();
    expect(screen.getByTestId('climb-row-menu-preview').getAttribute('data-style')).toBe(tappedPreview);
    expect(screen.getByTestId('climb-row-menu-actions').textContent).toBe(tappedActions);
    expect(runtime.haptic).toHaveBeenCalledTimes(2);
  });

  it('mounts exactly one row body while moving it into and out of the overlay', () => {
    render(<Harness rows={actionRows()} />);
    expect(runtime.mountedBodies).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    measureNext();
    expect(screen.getAllByTestId('row-body')).toHaveLength(1);
    expect(within(screen.getByTestId('full-window-overlay')).getByTestId('row-body')).toBeTruthy();
    expect(runtime.mountedBodies).toBe(1);
    fireEvent.click(screen.getByTestId('climb-row-menu-backdrop'));
    completeAnimations();
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    expect(screen.getAllByTestId('row-body')).toHaveLength(1);
    expect(runtime.mountedBodies).toBe(1);
    expect(runtime.maximumMountedBodies).toBe(1);
  });

  it('runs a selected action once after animation and overlay unmount', () => {
    const run = vi.fn(() => expect(screen.queryByTestId('full-window-overlay')).toBeNull());
    render(<Harness rows={actionRows(run)} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    measureNext();
    fireEvent.click(screen.getByTestId('climb-row-menu-action-share'));
    fireEvent.click(screen.getByTestId('climb-row-menu-action-playNext'));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByTestId('full-window-overlay')).toBeTruthy();
    completeAnimations();
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    expect(run).not.toHaveBeenCalled();
    completeFrames();
    expect(run).toHaveBeenCalledExactlyOnceWith('share');
    expect(runtime.focus).not.toHaveBeenCalled();
  });

  it('leaves the menu open when a disabled action is pressed', () => {
    const run = vi.fn();
    render(<Harness rows={actionRows(run)} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    measureNext();
    const disabledAction = screen.getByTestId('climb-row-menu-action-favorite');
    expect(disabledAction.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(disabledAction);
    completeAnimations();
    completeFrames();
    expect(screen.getByTestId('full-window-overlay')).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores measurements captured before a recycled row changes identity', () => {
    const view = render(<Harness rows={actionRows()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    completeFrames();
    view.rerender(<Harness rows={actionRows()} menuKey="climb-b" title="Granite" />);
    measureNext();
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    expect(runtime.haptic).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'More Granite' }));
    measureNext();
    expect(screen.getByRole('heading', { name: 'Granite' })).toBeTruthy();
  });

  it('retires an outstanding measurement when another row opens', () => {
    render(
      <>
        <Harness rows={actionRows()} />
        <Harness rows={actionRows()} menuKey="climb-b" title="Granite" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    completeFrames();
    fireEvent.click(screen.getByRole('button', { name: 'More Granite' }));
    measureNext();
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    measureNext();
    expect(screen.getAllByTestId('full-window-overlay')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Granite' })).toBeTruthy();
  });

  it('discards a measurement that finishes after unmount', () => {
    const view = render(<Harness rows={actionRows()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    completeFrames();
    view.unmount();
    measureNext();
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    expect(runtime.haptic).not.toHaveBeenCalled();
  });

  it('cancels a pending measurement when credentials change', () => {
    render(<Harness rows={actionRows()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    completeFrames();
    changeCredentials();
    measureNext();
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    expect(runtime.haptic).not.toHaveBeenCalled();
  });

  it.each(['during dismissal', 'after overlay unmount'])(
    'cancels the selected action when credentials change %s',
    (phase) => {
      const run = vi.fn();
      render(<Harness rows={actionRows(run)} />);
      fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
      measureNext();
      fireEvent.click(screen.getByTestId('climb-row-menu-action-share'));
      if (phase === 'after overlay unmount') completeAnimations();
      changeCredentials();
      completeAnimations();
      completeFrames();
      expect(screen.queryByTestId('full-window-overlay')).toBeNull();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('cancels a selected action if another row opens before its post-close frame', () => {
    const run = vi.fn();
    render(
      <>
        <Harness rows={actionRows(run)} />
        <Harness rows={actionRows()} menuKey="climb-b" title="Granite" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    measureNext();
    fireEvent.click(screen.getByTestId('climb-row-menu-action-share'));
    completeAnimations();
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More Granite' }));
    completeFrames();
    expect(run).not.toHaveBeenCalled();
    measureNext();
    expect(screen.getByRole('heading', { name: 'Granite' })).toBeTruthy();
  });

  it.each(['width', 'height', 'fontScale'] as const)('closes an open overlay after %s changes', (dimension) => {
    const rows = actionRows();
    const view = render(<Harness rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    measureNext();
    runtime.viewport = { ...runtime.viewport, [dimension]: runtime.viewport[dimension] + 1 };
    view.rerender(<Harness rows={rows} />);
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    completeFrames();
    // The menu closed under the climber: focus goes back to the ⋮ that opened it.
    expect(runtime.focus).toHaveBeenCalledExactlyOnceWith('More Rocky');
  });

  it('puts the keyboard away before it measures the row', () => {
    render(<Harness rows={actionRows()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    expect(runtime.dismissKeyboard).toHaveBeenCalledTimes(1);
    expect(runtime.measurements).toHaveLength(0);
    measureNext();
    expect(screen.getByTestId('full-window-overlay')).toBeTruthy();
  });

  it('hands focus back to the control that opened a cancelled menu', () => {
    const menuRef = createRef<ClimbListRowMenuHandle>();
    render(<Harness menuRef={menuRef} rows={actionRows()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    measureNext();
    fireEvent.click(screen.getByTestId('climb-row-menu-backdrop'));
    completeAnimations();
    completeFrames();
    expect(runtime.focus).toHaveBeenCalledExactlyOnceWith('More Rocky');

    // A hold opens it from the row, so the row gets focus back.
    act(() => menuRef.current?.open());
    measureNext();
    fireEvent.click(screen.getByTestId('climb-row-menu-backdrop'));
    completeAnimations();
    completeFrames();
    expect(runtime.focus).toHaveBeenLastCalledWith(42);
  });

  it('hands focus back when a target change retires the open menu, and runs nothing', () => {
    const run = vi.fn();
    const view = render(<Harness rows={actionRows(run)} />);
    fireEvent.click(screen.getByRole('button', { name: 'More Rocky' }));
    measureNext();
    view.rerender(<Harness rows={actionRows(run)} menuKey="climb-b" title="Granite" />);
    expect(screen.queryByTestId('full-window-overlay')).toBeNull();
    completeFrames();
    expect(runtime.focus).toHaveBeenCalledExactlyOnceWith('More Granite');
    expect(run).not.toHaveBeenCalled();
  });
});
