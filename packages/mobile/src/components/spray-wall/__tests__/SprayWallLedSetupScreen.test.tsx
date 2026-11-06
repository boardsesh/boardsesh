// @vitest-environment jsdom
import {
  createElement,
  useImperativeHandle,
  useEffect,
  type ComponentProps,
  type ReactNode,
  type ReactElement,
  type Ref,
} from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type Quad, type TnutLayout, type TnutPoint } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';
import type { SprayCornerMarker } from '../SprayCornerMarker';
import type { SprayPhotoCanvasProps } from '../SprayPhotoCanvas';
import type { LedPosition } from '@boardsesh/spray-wall-geometry';
type HoleEditorProps = {
  source: SprayLookPreviewSource;
  photoUri: string;
  holes: TnutPoint[];
  maxWidth: number;
  maxHeight: number;
  onTap: (point: TnutPoint, width: number, height: number) => void;
};
import {
  readTnutCalibrationSession,
  updateTnutCalibrationSession,
  closeTnutCalibrationSession,
} from '../../../lib/spray/tnut-calibration-session';

type HeaderAction = { onPress: () => void; disabled?: boolean; label?: string };
type HeaderActions = { leading: HeaderAction; trailing: HeaderAction };
const controls = vi.hoisted(() => ({
  header: null as HeaderActions | null,
  corner: null as ComponentProps<typeof SprayCornerMarker> | null,
  canvas: null as Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'> | null,
  editor: null as HoleEditorProps | null,
  leave: null as ((confirm: () => void) => void) | null,
  authenticated: true,
  viewerId: 'viewer-1' as string | null,
  back: vi.fn(),
  push: vi.fn(),
  alert: vi.fn(),
  scrollTo: vi.fn(),
}));
const backend = vi.hoisted(() => ({
  fetch: vi.fn(),
  source: null as SprayLookPreviewSource | null,
  cache: vi.fn(),
  sourceFromRenderData: vi.fn(),
  client: { invalidateQueries: vi.fn() },
}));
const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: controls.back, push: controls.push }),
  useIsFocused: () => true,
}));
const preview = vi.hoisted(() => ({
  available: true,
  state: 'idle',
  error: null,
  show: vi.fn(),
  stop: vi.fn(),
  lightAll: vi.fn(),
  chase: vi.fn(),
}));
vi.mock('../../../lib/spray/use-spray-led-preview', () => ({ useSprayLedPreview: () => preview }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 56 }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => backend.client }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: controls.authenticated }) }));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => controls.viewerId }));
vi.mock('../../../hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../../hooks/use-keyboard-height', () => ({ useKeyboardHeight: () => 0 }));
vi.mock('../../../hooks/use-header-actions', () => ({
  useHeaderActions: (actions: HeaderActions) => {
    controls.header = actions;
  },
}));
vi.mock('../use-spray-wizard-leave-guard', () => ({
  useSprayWizardLeaveGuard: (leave: (confirm: () => void) => void) => {
    controls.leave = leave;
  },
}));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({
  fetchSprayWallRenderData: backend.fetch,
  sprayWallPublishedRenderDataQueryKey: (wallUuid: string, generation: number) => ['wall', wallUuid, generation],
}));
vi.mock('../../../lib/spray/spray-wall-registry', () => ({ sprayWallViewerGeneration: () => 7 }));
vi.mock('../../../lib/spray/spray-photo-cache', () => ({ ensureSprayPhotoCached: backend.cache }));
vi.mock('../../../lib/spray/spray-look-preview', () => ({
  lookPreviewSourceFromRenderData: backend.sourceFromRenderData,
  cachedPhotoUri: (path: string | null) => (path?.startsWith('/') ? `file://${path}` : path),
}));
vi.mock('../../../lib/spray/spray-wall-tnut-store', () => ({
  loadSprayWallTnutLayout: storage.load,
  saveSprayWallTnutLayout: storage.save,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; label?: string }) =>
      options?.count !== undefined ? `${key}:${options.count}` : options?.label ? `${key}:${options.label}` : key,
  }),
}));
vi.mock('react-native', () => ({
  Alert: { alert: controls.alert },
  Keyboard: { dismiss: vi.fn() },
  TextInput: { State: { currentlyFocusedInput: () => undefined } },
  Platform: { OS: 'android' },
  Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement('div', { role: 'dialog' }, children) : null,
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({
    children,
    ref,
    onLayout,
  }: {
    children?: ReactNode;
    ref: Ref<{ scrollTo: typeof controls.scrollTo }>;
    onLayout: (event: { nativeEvent: { layout: { width: number } } }) => void;
  }) => {
    useEffect(() => {
      onLayout({ nativeEvent: { layout: { width: 400 } } });
    }, [onLayout]);
    useImperativeHandle(ref, () => ({ scrollTo: controls.scrollTo }));
    return createElement('div', null, children);
  },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', secondaryLabel: '#666', separator: '#ccc', secondaryGroupedBackground: '#eee' },
    brandColors: { primary: '#628', error: '#900' },
    spacing: [0, 4, 8, 12, 16, 20, 24],
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    title: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => createElement('button', { disabled, onClick: onPress, 'aria-label': accessibilityLabel }, title),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityState,
    disabled,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { checked?: boolean };
    disabled?: boolean;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        disabled,
        role: accessibilityRole,
        'aria-label': accessibilityLabel,
        'aria-checked': accessibilityState?.checked,
      },
      children,
    ),
}));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  BuilderTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    accessibilityLabel: string;
  }) =>
    createElement('input', {
      value,
      'aria-label': accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
vi.mock('../TnutPatternThumbnail', () => ({ TnutPatternThumbnail: () => null }));
vi.mock('../LedPlacementThumbnail', () => ({
  LedPlacementThumbnail: ({ placement, firstRowOffset }: { placement: string; firstRowOffset?: boolean }) =>
    placement === 'alternating'
      ? createElement('div', {
          'data-testid': 'alternating-thumbnail',
          'data-first-row-offset': String(firstRowOffset),
        })
      : null,
}));
vi.mock('../FlattenedSprayPhoto', () => ({
  FlattenedSprayPhoto: ({ photoUri }: { photoUri: string }) =>
    createElement('div', { 'data-testid': 'rectified-photo', 'data-uri': photoUri }),
}));
vi.mock('../SprayCornerMarker', () => ({
  SprayCornerMarker: (props: ComponentProps<typeof SprayCornerMarker>) => {
    controls.corner = props;
    return createElement('div', { 'data-testid': 'corner-marker' }, props.renderBackdrop?.(320, 448));
  },
}));
vi.mock('../CablePatternThumbnail', () => ({ CablePatternThumbnail: () => null }));
vi.mock('../SpraySetupOverlay', () => ({ SpraySetupOverlay: () => null, SPRAY_CABLE_COLOR: '#0891B2' }));
vi.mock('../SprayPhotoStage', () => ({
  SprayPhotoStage: ({
    canvas,
    width,
    overlayTools,
  }: {
    overlayTools?: ReactNode;
    canvas: Omit<SprayPhotoCanvasProps, 'maxWidth' | 'maxHeight'>;
    width: number;
  }) => {
    controls.canvas = canvas;
    const zoom = { value: 1 } as import('react-native-reanimated').SharedValue<number>;
    const pan = { value: 0 } as import('react-native-reanimated').SharedValue<number>;
    const overlay = canvas.renderOverlay?.(500, 700, zoom, pan, pan) as ReactElement<{
      holes: TnutPoint[];
      leds?: LedPosition[];
    }>;
    controls.editor = {
      source: canvas.source,
      photoUri: canvas.photoUri,
      holes: overlay.props.holes,
      maxWidth: width,
      maxHeight: width * 1.4,
      onTap: canvas.onTap ?? (() => {}),
    };
    return createElement(
      'div',
      {
        'data-testid': 'hole-editor',
        'data-count': overlay.props.holes.length,
        'data-led-count': overlay.props.leds?.length ?? 0,
      },
      overlayTools,
    );
  },
}));

import { SprayWallLedSetupScreen } from '../SprayWallLedSetupScreen';

const photoSource: SprayLookPreviewSource = {
  layoutId: 12,
  versionId: 34,
  photoUrl: 'https://example.com/wall.jpg?signature=private-temporary-url',
  photoExpiresAt: '2030-01-01T00:00:00Z',
  photo: { width: 1000, height: 1400 },
  frame: { width: 500, height: 700 },
  homography: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1],
  holds: [],
};
const photoKey = () =>
  JSON.stringify([photoSource.versionId, photoSource.frame.width, photoSource.frame.height, photoSource.homography]);
const savedLayout = (): TnutLayout => ({
  version: 1,
  photoKey: photoKey(),
  pattern: 'grid',
  rows: 8,
  columns: 8,
  firstRowOffset: false,
  corners: DEFAULT_TNUT_CORNERS,
  holes: [{ x: 0.3, y: 0.4 }],
});
const button = (name: string) => screen.getByRole('button', { name: `sprayLedSetup.${name}` });
const radio = (name: string) => screen.getByRole('radio', { name: `sprayLedSetup.${name}` });
const field = (name: string) => screen.getByRole('textbox', { name: `sprayLedSetup.${name}` }) as HTMLInputElement;
function next() {
  act(() => controls.header?.trailing.onPress());
}
function advanceToWiring() {
  next();
  next();
  next();
  next();
  next();
}
function finish() {
  advanceToWiring();
  next();
  next();
}
function back() {
  act(() => controls.header?.leading.onPress());
}
function tap(point: TnutPoint) {
  act(() => controls.editor?.onTap(point, 500, 700));
}
async function open() {
  const view = render(<SprayWallLedSetupScreen wallUuid="wall-1" />);
  await screen.findByText('sprayLedSetup.patternTitle');
  return view;
}
function expectHoles(count: number) {
  expect(screen.getByTestId('hole-editor').getAttribute('data-count')).toBe(String(count));
}

beforeEach(() => {
  vi.clearAllMocks();
  controls.header = null;
  controls.corner = null;
  controls.editor = null;
  controls.leave = null;
  controls.authenticated = true;
  controls.viewerId = 'viewer-1';
  backend.source = structuredClone(photoSource);
  backend.fetch
    .mockReset()
    .mockResolvedValue({ wall: { viewerCanEdit: true, layoutId: 12, currentVersion: { id: 34 } } });
  backend.sourceFromRenderData.mockReset().mockImplementation(() => backend.source);
  backend.cache.mockReset().mockResolvedValue('/cache/wall.jpg');
  backend.client.invalidateQueries.mockReset().mockResolvedValue(undefined);
  storage.load.mockReset().mockResolvedValue(null);
  storage.save.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('SprayWallLedSetupScreen', () => {
  it('migrates eight plus seven offset columns to fifteen without moving edited holes', async () => {
    storage.load.mockResolvedValue({ ...savedLayout(), pattern: 'offset' });
    await open();
    next();
    next();
    expect(field('columns').value).toBe('15');
    next();
    expect(controls.editor?.holes).toEqual(savedLayout().holes);
  });

  it('starts tools inactive, extends one cable, and tests with physical indices including skips', async () => {
    const holes = [
      { x: 0.2, y: 0.3 },
      { x: 0.5, y: 0.3 },
      { x: 0.8, y: 0.3 },
    ];
    storage.load.mockResolvedValue({ ...savedLayout(), rows: 2, columns: 3, holes });
    await open();
    next();
    next();
    next();
    await screen.findByText('sprayLedSetup.ledHint');
    fireEvent.click(radio('ledCenter'));
    next();
    expect(controls.canvas?.mode).toBe('pan');
    tap({ x: 0.1, y: 0.8 });
    expect(screen.getByTestId('hole-editor').getAttribute('data-led-count')).toBe('3');
    fireEvent.click(button('movePoint'));
    act(() => controls.canvas?.onMove?.({ x: 0.8, y: 0.3 }, { x: 0.8, y: 0.6 }, 500, 700));
    next();
    fireEvent.click(radio('customCable'));
    next();
    expect(screen.queryByText('sprayLedSetup.cableStartTitle')).toBeNull();
    expect(field('initialSkipLabel').value).toBe('0');
    fireEvent.change(field('initialSkipLabel'), { target: { value: '2' } });
    next();
    expect(controls.canvas?.mode).toBe('pan');
    expect(screen.queryByRole('button', { name: 'sprayLedSetup.cutCable' })).toBeNull();
    fireEvent.click(button('drawCable'));
    tap({ x: 0.2, y: 0.3 });
    act(() =>
      controls.canvas?.onTrace?.(
        [
          { x: 0.5, y: 0.3 },
          { x: 0.8, y: 0.6 },
        ],
        0.001,
      ),
    );
    fireEvent.click(button('selectLeds'));
    const checkbox = () => screen.getByRole('checkbox', { name: 'sprayLedSetup.lightSelected' });
    expect(checkbox().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(checkbox());
    tap({ x: 0.2, y: 0.3 });
    tap({ x: 0.5, y: 0.3 });
    expect(preview.show).toHaveBeenLastCalledWith([2, 3]);
    expect(checkbox().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('textbox', { name: 'sprayLedSetup.skipCount' })).toBeNull();
    fireEvent.click(button('cutCable'));
    fireEvent.click(button('connectCable'));
    fireEvent.click(button('insertSkips'));
    fireEvent.change(field('skipCount'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'sprayLed.confirm' }));
    next();
    expect(screen.getByText('sprayLedSetup.lightingTitle')).toBeTruthy();
    fireEvent.click(button('lightingChase'));
    expect(preview.chase).toHaveBeenLastCalledWith([2, 5, 6]);
    back();
    fireEvent.click(button('selectLeds'));
    expect(checkbox().getAttribute('aria-checked')).toBe('false');
    next();
    next();
    await waitFor(() => expect(controls.back).toHaveBeenCalledOnce());
    const saved = storage.save.mock.calls.at(-1)?.[1] as TnutLayout;
    expect(saved.holes).toEqual(holes);
    expect(saved.ledPositions).toContainEqual(expect.objectContaining({ x: 0.8, y: 0.6 }));
    expect(saved.wiring?.direction).toBe('custom');
    expect(saved.wiring?.initialSkip).toBe(2);
    expect(saved.wiring?.paths).toHaveLength(1);
    expect(saved.wiring?.paths[0]).toHaveLength(3);
    expect(saved.wiring?.skips[0].count).toBe(2);
  });

  it('uses the full width and keeps fullscreen edits in canonical coordinates across reopen and owner cleanup', async () => {
    const view = await open();
    next();
    expect(controls.corner).toMatchObject({ maxWidth: 400, maxHeight: 560, enableZoom: true, edgeToEdge: true });
    fireEvent.click(button('fullScreen'));
    const { sessionId } = controls.push.mock.calls[0][0].params as { sessionId: string };
    expect(readTnutCalibrationSession(sessionId)).toMatchObject({
      source: photoSource,
      photoUri: 'file:///cache/wall.jpg',
    });
    const adjusted: Quad = [
      [100, 140],
      [400, 140],
      [400, 560],
      [100, 560],
    ];
    act(() => updateTnutCalibrationSession(sessionId, adjusted));
    expect(controls.corner?.value).toEqual(adjusted);
    fireEvent.click(button('fullScreen'));
    expect(controls.push).toHaveBeenCalledOnce();
    act(() => closeTnutCalibrationSession(sessionId));
    fireEvent.click(button('fullScreen'));
    const secondId = controls.push.mock.calls[1][0].params.sessionId as string;
    expect(readTnutCalibrationSession(secondId)?.quad).toEqual(adjusted);
    view.unmount();
    expect(readTnutCalibrationSession(secondId)).toBeNull();
  });

  it('accepts one row or column and restores hidden corners without resetting them', async () => {
    await open();
    next();
    const adjusted: Quad = [
      [75, 100],
      [425, 110],
      [420, 610],
      [65, 600],
    ];
    act(() => controls.corner?.onChange(adjusted));
    fireEvent.change(field('rows'), { target: { value: '1' } });
    expect(screen.getByText('sprayLedSetup.singleRowHint')).toBeTruthy();
    expect(controls.header?.trailing.disabled).toBe(false);
    next();
    expectHoles(8);
    back();
    fireEvent.change(field('rows'), { target: { value: '8' } });
    expect(controls.corner?.value).toEqual(adjusted);
    fireEvent.change(field('columns'), { target: { value: '1' } });
    expect(screen.getByText('sprayLedSetup.singleColumnHint')).toBeTruthy();
    next();
    expectHoles(8);
    back();
    fireEvent.change(field('rows'), { target: { value: '1' } });
    expect(screen.getByText('sprayLedSetup.singlePointHint')).toBeTruthy();
    next();
    expectHoles(1);
    back();
    fireEvent.change(field('rows'), { target: { value: '8' } });
    fireEvent.change(field('columns'), { target: { value: '8' } });
    expect(controls.corner?.value).toEqual(adjusted);
  });

  it('starts each new step at the top without resetting scroll while editing that step', async () => {
    await open();
    await waitFor(() => expect(controls.scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false }));
    controls.scrollTo.mockClear();
    next();
    expect(controls.scrollTo).toHaveBeenCalledOnce();
    controls.scrollTo.mockClear();
    fireEvent.change(field('rows'), { target: { value: '9' } });
    expect(controls.scrollTo).not.toHaveBeenCalled();
    next();
    expect(controls.scrollTo).toHaveBeenCalledOnce();
    controls.scrollTo.mockClear();
    back();
    expect(controls.scrollTo).toHaveBeenCalledOnce();
    expect(controls.scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
  });

  it('loads the managed wall photo, aligns an 8×8 grid and saves canonical coordinates before LED placement selection', async () => {
    await open();
    expect(radio('grid').getAttribute('aria-checked')).toBe('true');
    expect(storage.load).toHaveBeenCalledWith('wall-1');
    expect(backend.cache).toHaveBeenCalledWith(
      { layoutId: 12, versionId: 34 },
      { url: photoSource.photoUrl, expiresAt: photoSource.photoExpiresAt },
    );
    next();
    expect(screen.getByText('sprayLedSetup.alignTitle')).toBeTruthy();
    expect(field('rows').value).toBe('8');
    expect(field('columns').value).toBe('8');
    expect(controls.corner?.photo).toEqual({ uri: 'file:///cache/wall.jpg', width: 500, height: 700 });
    expect(controls.corner?.value).toEqual([
      [50, 70],
      [450, 70],
      [450, 630],
      [50, 630],
    ]);
    expect(screen.getByTestId('rectified-photo').getAttribute('data-uri')).toBe('file:///cache/wall.jpg');
    next();
    expectHoles(64);
    expect(storage.save).not.toHaveBeenCalled();
    next();
    await screen.findByText('sprayLedSetup.ledHint');
    expect(storage.save).toHaveBeenCalledWith(
      'wall-1',
      expect.objectContaining({ photoKey: photoKey(), pattern: 'grid', rows: 8, columns: 8 }),
    );
    const stored = storage.save.mock.calls[0][1] as TnutLayout;
    expect(stored.holes).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain('signature');
    back();
    expectHoles(64);
    next();
    await screen.findByText('sprayLedSetup.ledHint');
    expect(controls.header?.trailing.disabled).toBe(true);
    fireEvent.click(radio('ledCenter'));
    finish();
    await waitFor(() => expect(controls.back).toHaveBeenCalledOnce());
    const leave = vi.fn();
    act(() => controls.leave?.(leave));
    expect(leave).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'asks for the offset phase and counts all 8 vertical positions (first row inset: %s)',
    async (firstRowOffset) => {
      await open();
      fireEvent.click(radio('offset'));
      next();
      expect(screen.getByText('sprayLedSetup.offsetTitle')).toBeTruthy();
      fireEvent.click(radio(firstRowOffset ? 'firstInset' : 'firstFull'));
      next();
      expect(screen.getByText('sprayLedSetup.offsetAlignHint')).toBeTruthy();
      expect(screen.getByText('sprayLedSetup.countHint')).toBeTruthy();
      expect(controls.corner?.tnutGrid?.firstRowOffset).toBe(firstRowOffset);
      next();
      expectHoles(32);
      expect(controls.editor?.holes.filter((point) => Math.abs(point.y - 0.1) < 1e-9)).toHaveLength(4);
    },
  );

  it('lets a custom wall add, remove and undo holes, refusing to continue with none', async () => {
    await open();
    fireEvent.click(radio('custom'));
    next();
    expectHoles(0);
    expect(controls.header?.trailing.disabled).toBe(true);
    next();
    expect(storage.save).not.toHaveBeenCalled();
    tap({ x: 0.2, y: 0.3 });
    expectHoles(0);
    fireEvent.click(button('add'));
    tap({ x: 0.2, y: 0.3 });
    tap({ x: 0.2, y: 0.3 });
    expectHoles(1);
    tap({ x: 0.7, y: 0.8 });
    expectHoles(2);
    fireEvent.click(button('remove'));
    tap({ x: 0.2, y: 0.3 });
    expectHoles(1);
    fireEvent.click(button('undo'));
    expectHoles(2);
    expect(controls.header?.trailing.disabled).toBe(false);
  });

  it('explains imaginary endpoints for one inset row and keeps its holes inside the anchors', async () => {
    await open();
    fireEvent.click(radio('offset'));
    next();
    fireEvent.click(radio('firstInset'));
    next();
    fireEvent.change(field('rows'), { target: { value: '1' } });
    expect(screen.getByText('sprayLedSetup.singleOffsetRowHint')).toBeTruthy();
    next();
    expectHoles(4);
    expect(controls.editor?.holes[0].x).toBeGreaterThan(DEFAULT_TNUT_CORNERS.topLeft.x);
    expect(controls.editor?.holes.at(-1)?.x).toBeLessThanOrEqual(DEFAULT_TNUT_CORNERS.topRight.x);
  });

  it('preserves manual corrections through Back and Next while the grid is unchanged', async () => {
    await open();
    next();
    next();
    fireEvent.click(button('remove'));
    tap({ x: 0.1, y: 0.1 });
    expectHoles(63);
    fireEvent.click(button('add'));
    tap({ x: 0.04, y: 0.04 });
    const corrected = structuredClone(controls.editor?.holes);
    back();
    expect(screen.getByText('sprayLedSetup.alignTitle')).toBeTruthy();
    next();
    expect(controls.editor?.holes).toEqual(corrected);
    back();
    fireEvent.change(field('rows'), { target: { value: '9' } });
    expect(screen.getByText('sprayLedSetup.regenerateHint')).toBeTruthy();
    next();
    expectHoles(72);
    expect(controls.editor?.holes).not.toContainEqual({ x: 0.04, y: 0.04 });
  });

  it('updates counts using direct entry and buttons, blocking invalid counts and crossed corners', async () => {
    await open();
    next();
    fireEvent.click(screen.getByRole('button', { name: 'sprayLedSetup.increase:sprayLedSetup.rows' }));
    expect(field('rows').value).toBe('9');
    expect(controls.corner?.tnutGrid?.rows).toBe(9);
    fireEvent.click(screen.getByRole('button', { name: 'sprayLedSetup.decrease:sprayLedSetup.rows' }));
    expect(field('rows').value).toBe('8');
    fireEvent.change(field('columns'), { target: { value: '51' } });
    expect(controls.header?.trailing.disabled).toBe(true);
    next();
    expect(screen.getByText('sprayLedSetup.countRange')).toBeTruthy();
    expect(screen.queryByTestId('hole-editor')).toBeNull();
    fireEvent.change(field('columns'), { target: { value: '6' } });
    expect(controls.header?.trailing.disabled).toBe(false);
    act(() =>
      controls.corner?.onChange([
        [50, 70],
        [450, 630],
        [450, 70],
        [50, 630],
      ]),
    );
    expect(controls.header?.trailing.disabled).toBe(true);
    next();
    expect(screen.getByText('sprayLedSetup.invalidCorners')).toBeTruthy();
    fireEvent.click(button('resetCorners'));
    expect(controls.header?.trailing.disabled).toBe(false);
    next();
    expectHoles(48);
  });

  it('keeps edits on a save failure and retries without entering the LED step prematurely', async () => {
    storage.save.mockRejectedValueOnce(new Error('Disk unavailable'));
    await open();
    next();
    next();
    next();
    await screen.findByText('sprayLedSetup.saveFailed');
    expectHoles(64);
    expect(screen.queryByText('sprayLedSetup.ledHint')).toBeNull();
    expect(controls.header?.trailing.disabled).toBe(false);
    next();
    await screen.findByText('sprayLedSetup.ledHint');
    expect(storage.save).toHaveBeenCalledTimes(2);
  });

  it('reopens saved manual corrections when the photo version, frame and transform still match', async () => {
    storage.load.mockResolvedValue(savedLayout());
    await open();
    next();
    next();
    expectHoles(1);
    expect(controls.editor?.holes).toEqual(savedLayout().holes);
  });

  it.each(['grid', 'offset', 'custom'] as const)(
    'offers all three LED placements for %s and restores the saved choice',
    async (pattern) => {
      storage.load.mockResolvedValue({ ...savedLayout(), pattern, ledPlacement: 'sides' });
      await open();
      next();
      if (pattern === 'offset') next();
      if (pattern !== 'custom') next();
      next();
      await screen.findByText('sprayLedSetup.ledHint');
      expect(radio('ledCenter')).toBeTruthy();
      expect(radio('ledBelow')).toBeTruthy();
      expect(radio('ledSides').getAttribute('aria-checked')).toBe('true');
      expect(screen.queryByRole('radio', { name: 'sprayLedSetup.ledAlternating' }) !== null).toBe(pattern === 'offset');
      fireEvent.click(radio('ledBelow'));
      back();
      next();
      await screen.findByText('sprayLedSetup.ledHint');
      expect(radio('ledBelow').getAttribute('aria-checked')).toBe('true');
      finish();
      await waitFor(() => expect(controls.back).toHaveBeenCalledOnce());
      expect(storage.save).toHaveBeenLastCalledWith(
        'wall-1',
        expect.objectContaining({ pattern, ledPlacement: 'below' }),
      );
    },
  );

  it.each([false, true])(
    'restores complementary positions and follows changes to the first-row phase (%s)',
    async (firstRowOffset) => {
      storage.load.mockResolvedValue({
        ...savedLayout(),
        pattern: 'offset',
        firstRowOffset,
        ledPlacement: 'alternating',
      });
      await open();
      next();
      next();
      next();
      next();
      await screen.findByText('sprayLedSetup.ledHint');
      expect(radio('ledAlternating').getAttribute('aria-checked')).toBe('true');
      expect(screen.getByTestId('alternating-thumbnail').getAttribute('data-first-row-offset')).toBe(
        String(firstRowOffset),
      );
      back();
      back();
      back();
      fireEvent.click(radio(firstRowOffset ? 'firstFull' : 'firstInset'));
      next();
      next();
      next();
      await screen.findByText('sprayLedSetup.ledHint');
      expect(radio('ledAlternating').getAttribute('aria-checked')).toBe('true');
      expect(screen.getByTestId('alternating-thumbnail').getAttribute('data-first-row-offset')).toBe(
        String(!firstRowOffset),
      );
      finish();
      await waitFor(() => expect(controls.back).toHaveBeenCalledOnce());
      expect(storage.save).toHaveBeenLastCalledWith(
        'wall-1',
        expect.objectContaining({ pattern: 'offset', firstRowOffset: !firstRowOffset, ledPlacement: 'alternating' }),
      );
    },
  );

  it.each(['grid', 'custom'] as const)(
    'clears complementary positions when changing the wall pattern to %s',
    async (pattern) => {
      storage.load.mockResolvedValue({ ...savedLayout(), pattern: 'offset' });
      await open();
      next();
      next();
      next();
      next();
      await screen.findByText('sprayLedSetup.ledHint');
      fireEvent.click(radio('ledAlternating'));
      expect(radio('ledAlternating').getAttribute('aria-checked')).toBe('true');
      back();
      back();
      back();
      back();
      fireEvent.click(radio(pattern));
      next();
      if (pattern === 'grid') next();
      else {
        fireEvent.click(button('add'));
        tap({ x: 0.5, y: 0.5 });
      }
      next();
      await screen.findByText('sprayLedSetup.ledHint');
      expect(screen.queryByRole('radio', { name: 'sprayLedSetup.ledAlternating' })).toBeNull();
      expect(controls.header?.trailing.disabled).toBe(true);
      expect(storage.save).toHaveBeenLastCalledWith(
        'wall-1',
        expect.objectContaining({ pattern, ledPlacement: undefined }),
      );
    },
  );

  it('keeps positions and cable edits on write failure and guards duplicate saves', async () => {
    storage.load.mockResolvedValue(savedLayout());
    await open();
    next();
    next();
    next();
    await screen.findByText('sprayLedSetup.ledHint');
    fireEvent.click(radio('ledSides'));
    advanceToWiring();
    expect(screen.getByText('sprayLedSetup.wiringTitle')).toBeTruthy();
    next();
    storage.save.mockRejectedValueOnce(new Error('Disk full'));
    next();
    await screen.findByText('sprayLedSetup.saveFailed');
    expect(controls.back).not.toHaveBeenCalled();
    let resolveSave: (() => void) | undefined;
    storage.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const leaveAfterSave = vi.fn();
    controls.back.mockImplementationOnce(() => controls.leave?.(leaveAfterSave));
    next();
    next();
    back();
    expect(storage.save).toHaveBeenCalledTimes(3);
    expect(controls.header?.trailing.disabled).toBe(true);
    await act(async () => resolveSave?.());
    expect(controls.back).toHaveBeenCalledOnce();
    expect(leaveAfterSave).toHaveBeenCalledOnce();
  });

  it('retains an unsaved LED choice across wall pattern changes and guards leaving', async () => {
    storage.load.mockResolvedValue(savedLayout());
    await open();
    next();
    next();
    next();
    await screen.findByText('sprayLedSetup.ledHint');
    fireEvent.click(radio('ledCenter'));
    back();
    back();
    back();
    const leave = vi.fn();
    act(() => controls.leave?.(leave));
    expect(leave).not.toHaveBeenCalled();
    expect(controls.alert).toHaveBeenCalledOnce();
    fireEvent.click(radio('custom'));
    next();
    fireEvent.click(button('add'));
    tap({ x: 0.5, y: 0.5 });
    next();
    await screen.findByText('sprayLedSetup.ledHint');
    expect(radio('ledCenter').getAttribute('aria-checked')).toBe('true');
  });

  it.each(['version', 'frame', 'transform'] as const)(
    'ignores saved positions when the photo %s changes',
    async (changed) => {
      storage.load.mockResolvedValue(savedLayout());
      if (!backend.source) throw new Error('Missing fixture');
      if (changed === 'version') backend.source.versionId++;
      if (changed === 'frame') backend.source.frame.width++;
      if (changed === 'transform') backend.source.homography[2] = 12;
      await open();
      expect(screen.getByText('sprayLedSetup.photoChanged')).toBeTruthy();
      next();
      next();
      expectHoles(64);
      expect(storage.save).not.toHaveBeenCalled();
    },
  );

  it('does not fetch private photos before authentication or when edit access is absent', async () => {
    controls.authenticated = false;
    const view = render(<SprayWallLedSetupScreen wallUuid="wall-1" />);
    expect(backend.fetch).not.toHaveBeenCalled();
    controls.authenticated = true;
    backend.fetch.mockResolvedValue({ wall: { viewerCanEdit: false } });
    view.rerender(<SprayWallLedSetupScreen wallUuid="wall-1" />);
    await screen.findByText('sprayLedSetup.unavailable');
    expect(backend.cache).not.toHaveBeenCalled();
    expect(controls.header).toBeNull();
  });

  it('retries a photo-load failure through the viewer-scoped query key', async () => {
    backend.cache.mockRejectedValueOnce(new Error('Download failed'));
    render(<SprayWallLedSetupScreen wallUuid="wall-1" />);
    await screen.findByText('sprayLedSetup.loadFailed');
    fireEvent.click(button('retry'));
    await screen.findByText('sprayLedSetup.patternTitle');
    expect(backend.client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['wall', 'wall-1', 7] });
    await waitFor(() => expect(backend.cache).toHaveBeenCalledTimes(2));
  });
});
