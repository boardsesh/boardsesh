// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';
import {
  createSprayPhotoSession,
  readSprayPhotoSession,
  updateSprayPhotoSession,
  closeSprayPhotoSession,
} from '../../../lib/spray/spray-photo-session';
import type { SprayCornerMarker } from '../SprayCornerMarker';
import {
  closeTnutCalibrationSession,
  createTnutCalibrationSession,
  readTnutCalibrationSession,
  type TnutCalibrationSession,
} from '../../../lib/spray/tnut-calibration-session';

const controls = vi.hoisted(() => ({
  id: undefined as string | string[] | undefined,
  photoId: undefined as string | undefined,
  canvas: null as SprayPhotoCanvasProps | null,
  viewerId: 'viewer-one',
  authenticated: true,
  marker: null as ComponentProps<typeof SprayCornerMarker> | null,
  leave: null as ((confirm: () => void) => void) | null,
  back: vi.fn(),
  platformOS: 'android',
  setStatusBarHidden: vi.fn(),
  surfaces: new Map<
    string,
    {
      onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
      onContentSizeChange?: (width: number, height: number) => void;
      style?: { height?: number };
    }
  >(),
}));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ sessionId: controls.id, photoSessionId: controls.photoId }),
  useRouter: () => ({ back: controls.back }),
  Redirect: ({ href }: { href: string }) => createElement('div', { 'data-testid': 'redirect' }, href),
}));
vi.mock('react-native', () => {
  const Surface = ({ children, testID, ...props }: { children?: ReactNode; testID?: string }) => {
    if (testID) controls.surfaces.set(testID, props);
    return createElement('div', { 'data-testid': testID }, children);
  };
  return {
    Platform: {
      get OS() {
        return controls.platformOS;
      },
    },
    StatusBar: { setHidden: controls.setStatusBarHidden },
    View: Surface,
    ScrollView: Surface,
    StyleSheet: { create: (styles: unknown) => styles },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 20, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: controls.authenticated }) }));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => controls.viewerId }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', secondaryGroupedBackground: '#eee', label: '#111' },
    spacing: [0, 4, 8],
  }),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../launch-update/hold-until-launch-ready', () => ({
  holdUntilLaunchReady: (component: () => ReactNode) => component,
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
    disabled?: boolean;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, disabled }),
}));
vi.mock('../SprayPhotoCanvas', () => ({
  SprayPhotoCanvas: (props: SprayPhotoCanvasProps) => {
    controls.canvas = props;
    return createElement('div', { 'data-testid': 'photo-canvas' });
  },
}));
vi.mock('../SprayCornerMarker', () => ({
  SprayCornerMarker: (props: ComponentProps<typeof SprayCornerMarker>) => {
    controls.marker = props;
    return createElement('div', { 'data-testid': 'marker' }, props.renderBackdrop?.(300, 450));
  },
}));
vi.mock('../FlattenedSprayPhoto', () => ({
  FlattenedSprayPhoto: ({ photoUri }: { photoUri: string }) =>
    createElement('div', { 'data-testid': 'rectified-photo', 'data-uri': photoUri }),
}));
vi.mock('../use-spray-wizard-leave-guard', () => ({
  useSprayWizardLeaveGuard: (leave: (confirm: () => void) => void) => {
    controls.leave = leave;
  },
}));

import SprayLedFullscreen from '../../../../app/spray-led-fullscreen';

const openSessions = new Set<string>();
function open() {
  const snapshot: TnutCalibrationSession = {
    viewerId: 'viewer-one',
    photoUri: 'file:///cached/private-photo.jpg',
    source: {
      layoutId: 12,
      versionId: 34,
      photoUrl: 'https://example.invalid/photo?signature=private',
      photoExpiresAt: '2030-01-01',
      photo: { width: 1000, height: 1500 },
      frame: { width: 800, height: 1200 },
      homography: [0.8, 0, 0, 0, 0.8, 0, 0, 0, 1],
      holds: [],
    },
    quad: [
      [80, 120],
      [720, 120],
      [720, 1080],
      [80, 1080],
    ],
    grid: { pattern: 'grid', rows: 8, columns: 8, firstRowOffset: false },
  };
  const onChange = vi.fn();
  const onClose = vi.fn();
  const id = createTnutCalibrationSession(snapshot, onChange, onClose);
  openSessions.add(id);
  controls.id = id;
  return { id, snapshot, onChange, onClose };
}
beforeEach(() => {
  controls.id = undefined;
  controls.photoId = undefined;
  controls.canvas = null;
  controls.viewerId = 'viewer-one';
  controls.authenticated = true;
  controls.marker = null;
  controls.leave = null;
  controls.back.mockReset();
  controls.platformOS = 'android';
  controls.setStatusBarHidden.mockReset();
  controls.surfaces.clear();
});
afterEach(() => {
  cleanup();
  for (const id of openSessions) closeTnutCalibrationSession(id);
  openSessions.clear();
});

describe('status bar', () => {
  it('hides on iOS while the route is up and comes back when it closes', () => {
    controls.platformOS = 'ios';
    open();
    const view = render(createElement(SprayLedFullscreen));
    expect(controls.setStatusBarHidden.mock.calls).toEqual([[true, 'none']]);
    view.unmount();
    expect(controls.setStatusBarHidden.mock.calls).toEqual([
      [true, 'none'],
      [false, 'none'],
    ]);
  });

  it('leaves Android to the stack option', () => {
    open();
    const view = render(createElement(SprayLedFullscreen));
    view.unmount();
    expect(controls.setStatusBarHidden).not.toHaveBeenCalled();
  });
});

describe('fullscreen T-nut calibration route', () => {
  it('uses the same rectified source and canonical corner dimensions, and returns edits to its owner', () => {
    const { id, snapshot, onChange } = open();
    render(createElement(SprayLedFullscreen));
    expect(controls.marker?.photo).toEqual({ uri: snapshot.photoUri, width: 800, height: 1200 });
    expect(screen.getByTestId('rectified-photo').getAttribute('data-uri')).toBe(snapshot.photoUri);
    expect(controls.marker?.enableZoom).toBe(true);
    expect(controls.marker?.edgeToEdge).toBe(true);
    expect(controls.marker?.invalid).toBe(false);
    act(() =>
      controls.marker?.onChange([
        [100, 160],
        [720, 120],
        [720, 1080],
        [80, 1080],
      ]),
    );
    expect(onChange).toHaveBeenCalledOnce();
    expect(readTnutCalibrationSession(id)?.quad[0]).toEqual([100, 160]);
    expect(controls.marker?.value?.[0]).toEqual([100, 160]);
  });

  it.each([undefined, 'missing', ['ambiguous', 'id']])(
    'redirects unusable handoff %j without rendering a private photo',
    (id) => {
      controls.id = id;
      render(createElement(SprayLedFullscreen));
      expect(screen.getByTestId('redirect').textContent).toBe('/boards');
      expect(screen.queryByTestId('marker')).toBeNull();
    },
  );

  it.each(['signed-out', 'other-viewer'])('keeps the photo private for %s', (scenario) => {
    open();
    controls.authenticated = scenario !== 'signed-out';
    controls.viewerId = scenario === 'other-viewer' ? 'viewer-two' : 'viewer-one';
    render(createElement(SprayLedFullscreen));
    expect(screen.getByTestId('redirect').textContent).toBe('/boards');
    expect(screen.queryByTestId('marker')).toBeNull();
  });

  it('closes through the navigation guard once without redirecting during removal', () => {
    const { id, onClose } = open();
    const leave = vi.fn();
    controls.back.mockImplementation(() => controls.leave?.(leave));
    render(createElement(SprayLedFullscreen));
    fireEvent.click(screen.getByRole('button', { name: 'sprayLedSetup.closeFullScreen' }));
    expect(leave).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(readTnutCalibrationSession(id)).toBeNull();
    expect(screen.queryByTestId('redirect')).toBeNull();
  });

  it('disables the close button during a drag and redirects if its parent revokes the session', () => {
    const { id } = open();
    render(createElement(SprayLedFullscreen));
    act(() => controls.marker?.onDragActiveChange?.(true));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    act(() => controls.marker?.onDragActiveChange?.(false));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
    act(() => closeTnutCalibrationSession(id));
    expect(screen.getByTestId('redirect').textContent).toBe('/boards');
    expect(screen.queryByTestId('marker')).toBeNull();
  });
});

describe('fullscreen point/cable editors', () => {
  it('uses a side rail in matching orientation, retains accessory actions, and fits the measured canvas box', () => {
    const { snapshot } = open();
    controls.id = undefined;
    const id = createSprayPhotoSession(
      {
        viewerId: 'viewer-one',
        canvas: { source: snapshot.source, photoUri: snapshot.photoUri },
        tools: createElement('span', null, 'bottom tools'),
        fullScreenRail: createElement('span', null, 'rail tools'),
        overlayTools: createElement('span', null, 'undo'),
        accessoryTools: createElement('span', null, 'gap editor'),
      },
      vi.fn(),
    );
    controls.photoId = id;
    render(createElement(SprayLedFullscreen));
    act(() =>
      controls.surfaces
        .get('spray-fullscreen-layout')
        ?.onLayout?.({ nativeEvent: { layout: { width: 400, height: 800 } } }),
    );
    expect(screen.getByText('rail tools')).toBeTruthy();
    expect(screen.queryByText('bottom tools')).toBeNull();
    expect(screen.getByText('undo')).toBeTruthy();
    expect(screen.getByText('gap editor')).toBeTruthy();
    act(() =>
      controls.surfaces
        .get('spray-fullscreen-canvas')
        ?.onLayout?.({ nativeEvent: { layout: { width: 340, height: 710 } } }),
    );
    expect(controls.canvas?.maxWidth).toBe(340);
    expect(controls.canvas?.maxHeight).toBe(710);
    act(() =>
      controls.surfaces
        .get('spray-fullscreen-layout')
        ?.onLayout?.({ nativeEvent: { layout: { width: 1100, height: 600 } } }),
    );
    expect(screen.getByText('bottom tools')).toBeTruthy();
    expect(screen.queryByText('rail tools')).toBeNull();
    act(() => controls.surfaces.get('spray-fullscreen-bottom-tools')?.onContentSizeChange?.(1100, 64));
    expect(controls.surfaces.get('spray-fullscreen-bottom-tools')?.style?.height).toBe(64);
    act(() => closeSprayPhotoSession(id));
  });
  it('shares the rectified frame and live tools without exposing photo URLs in navigation', () => {
    const { snapshot } = open();
    controls.id = undefined;
    const onTap = vi.fn(),
      onClose = vi.fn();
    const session = {
      viewerId: 'viewer-one',
      canvas: { source: snapshot.source, photoUri: snapshot.photoUri, mode: 'tap' as const, onTap },
      tools: createElement('span', null, 'initial-tools'),
    };
    const id = createSprayPhotoSession(session, onClose);
    controls.photoId = id;
    const view = render(createElement(SprayLedFullscreen));
    expect(screen.getByTestId('photo-canvas')).toBeTruthy();
    expect(controls.canvas?.source).toEqual(snapshot.source);
    expect(controls.canvas?.photoUri).toBe(snapshot.photoUri);
    act(() => controls.canvas?.onTap?.({ x: 0.2, y: 0.3 }, 300, 450));
    expect(onTap).toHaveBeenCalledExactlyOnceWith({ x: 0.2, y: 0.3 }, 300, 450);
    act(() =>
      updateSprayPhotoSession(id, {
        ...session,
        canvas: { ...session.canvas, mode: 'pan' },
        tools: createElement('span', null, 'changed-tools'),
      }),
    );
    expect(screen.getByText('changed-tools')).toBeTruthy();
    expect(controls.canvas?.mode).toBe('pan');
    const leave = vi.fn();
    act(() => controls.leave?.(leave));
    expect(leave).toHaveBeenCalledOnce();
    expect(readSprayPhotoSession(id)).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('redirect')).toBeNull();
    view.unmount();
    closeSprayPhotoSession(id);
  });
  it('hides a private point editor from another viewer and reacts to owner revocation', () => {
    const { snapshot } = open();
    controls.id = undefined;
    const id = createSprayPhotoSession(
      { viewerId: 'viewer-one', canvas: { source: snapshot.source, photoUri: snapshot.photoUri }, tools: null },
      vi.fn(),
    );
    controls.photoId = id;
    controls.viewerId = 'other';
    const view = render(createElement(SprayLedFullscreen));
    expect(screen.queryByTestId('photo-canvas')).toBeNull();
    expect(screen.getByTestId('redirect')).toBeTruthy();
    controls.viewerId = 'viewer-one';
    view.rerender(createElement(SprayLedFullscreen));
    expect(screen.getByTestId('photo-canvas')).toBeTruthy();
    act(() => closeSprayPhotoSession(id));
    expect(screen.queryByTestId('photo-canvas')).toBeNull();
    expect(screen.getByTestId('redirect')).toBeTruthy();
  });
});
