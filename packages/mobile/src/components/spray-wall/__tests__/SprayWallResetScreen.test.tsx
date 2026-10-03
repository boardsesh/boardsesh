// @vitest-environment jsdom
//
// The reset flow, mounted.
//
// `reset-wall-machine` covers the transitions; this covers the screen that draws
// them, and in particular the four places it refuses to go on. Each refusal is
// there because the alternative damages a wall or strands a draft:
//
//  - a wall the viewer cannot edit, or one with nothing published, has no reset
//    to run;
//  - an abandoned draft resumes its durable detection when its photo is valid;
//  - and the anchors gate, which is the whole reason this flow is not the
//    add-a-wall wizard: without four corners the matcher reports the entire wall
//    as removed.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const wallQueryState = vi.hoisted(() => ({ current: { data: null as unknown, isPending: false } }));
const pickResult = vi.hoisted(() => ({
  current: { outcome: 'picked', photo: { uri: 'file:///w.jpg', width: 2048, height: 1536 } } as unknown,
}));
const discardMutateAsync = vi.hoisted(() => vi.fn(async () => true));
const targetMocks = vi.hoisted(() => ({
  fetchWall: vi.fn(),
  createWall: vi.fn(),
  createVersion: vi.fn(),
  publish: vi.fn(),
  discardDraft: vi.fn(),
  updateVisibility: vi.fn(),
  finish: vi.fn(),
  invalidateQueries: vi.fn(),
  replace: vi.fn(),
}));
/** The corner marker's props, so a test can hand the screen four corners. */
const markerProps = vi.hoisted(() => ({ current: null as null | { onChange?: (quad: unknown) => void } }));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  Platform: { OS: 'ios' },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { hairlineWidth: 1, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('expo-image', () => ({ Image: () => createElement('img', { 'data-testid': 'preview' }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), replace: targetMocks.replace }),
  useNavigation: () => ({ addListener: () => () => {}, dispatch: vi.fn() }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemBlue: '#007AFF', systemRed: '#FF3B30' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#000', secondaryLabel: '#888', separator: '#222', tertiaryBackground: '#333' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
// The screen reaches analytics through the SW-17 builders, which return the
// event name and its properties as one payload for `trackSprayEvent` to unpack.
// Stubbed to that shape so a missing export cannot silently swallow a dispatch.
vi.mock('@boardsesh/analytics', () => ({
  sprayWallPhotoPicked: (source: string) => ({ name: 'p', properties: { source } }),
  sprayWallUploadFinished: (properties: Record<string, unknown>) => ({ name: 'u', properties }),
  sprayWallDetectionFinished: (properties: Record<string, unknown>) => ({ name: 'd', properties }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: (e: unknown) => (e as Error)?.message,
  extractGraphqlCode: () => undefined,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled, 'data-disabled': disabled ? 'true' : 'false' }, title),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
}));
vi.mock('../SprayCornerMarker', () => ({
  SprayCornerMarker: (props: { onChange?: (quad: unknown) => void }) => {
    markerProps.current = props;
    return createElement('div', { 'data-testid': 'corner-marker' });
  },
}));
vi.mock('../SprayResetCompareScreen', () => ({
  SprayResetCompareScreen: () => createElement('div', { 'data-testid': 'compare' }),
}));

vi.mock('../../../lib/spray/spray-wall-photo-upload', () => ({ uploadSprayWallPhoto: vi.fn() }));
vi.mock('../SprayDetectionStep', () => ({
  SprayDetectionStep: ({
    wallUuid,
    versionId,
    onManual,
  }: {
    wallUuid: string;
    versionId: string;
    onManual?: () => void;
  }) =>
    createElement('div', {
      'data-testid': 'detection',
      'data-wall': wallUuid,
      'data-version': versionId,
      'data-manual': Boolean(onManual),
    }),
}));
vi.mock('../../../lib/spray/camera-capability', () => ({ canPhotographWall: () => false }));
vi.mock('../../../lib/spray/wall-photo', () => ({
  pickWallPhotoFromLibrary: vi.fn(async () => pickResult.current),
  pickWallPhotoFromCamera: vi.fn(async () => pickResult.current),
  rescalePoint: (point: [number, number]) => point,
}));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  useCreateSprayWallVersion: () => ({ mutateAsync: targetMocks.createVersion }),
  useCreateSprayWall: () => ({ mutateAsync: targetMocks.createWall }),
  usePublishSprayWallVersion: () => ({ mutateAsync: targetMocks.publish }),
  useDiscardSprayWallDraft: () => ({ mutateAsync: targetMocks.discardDraft }),
  useUpdateSprayWallVisibility: () => ({ mutateAsync: targetMocks.updateVisibility }),
  useMySprayWalls: () => ({ data: [], isFetching: false, dataUpdatedAt: 0, errorUpdatedAt: 0, refetch: vi.fn() }),
  fetchSprayWallVersions: targetMocks.fetchWall,
}));
vi.mock('../../../lib/spray/use-spray-wall-reset', () => ({
  useSprayWallWithVersions: () => wallQueryState.current,
  useDiscardSprayWallVersion: () => ({ mutateAsync: discardMutateAsync, isPending: false }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: targetMocks.invalidateQueries }),
}));
vi.mock('../../../lib/boards/use-activate-board', () => ({ useActivateBoard: () => targetMocks.finish }));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({ invalidateSprayWallRenderData: vi.fn() }));
vi.mock('../../board-discovery/use-spray-wall-builder', () => ({
  SPRAY_ANGLE_OPTIONS: [40],
  useSprayWallBuilder: () => ({}),
}));
vi.mock('../../board-discovery/GymPickerSheet', () => ({ GymPickerSheet: () => null }));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  BoardIdentityFields: () => null,
  BoardVisibilityFields: () => null,
  SectionLabel: () => null,
}));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../SprayWallLookStep', () => ({ SprayWallLookStep: () => null }));
vi.mock('../../outline-editor/SprayHoldEditorScreen', () => ({
  confirmDiscardSprayEdits: vi.fn(),
  SprayHoldEditorScreen: (props: {
    wallUuid: string;
    versionId: string;
    candidates: unknown[];
    notice?: { message: string };
  }) =>
    createElement('div', {
      'data-testid': 'hold-editor',
      'data-wall': props.wallUuid,
      'data-version': props.versionId,
      'data-candidate-count': props.candidates.length,
    }),
}));

const { SprayWallResetScreen } = await import('../SprayWallResetScreen');
const { SprayWallWizardScreen } = await import('../SprayWallWizardScreen');

const SQUARE = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

const EDITABLE_WALL = {
  uuid: 'wall-1',
  layoutId: 9001,
  viewerCanEdit: true,
  currentVersion: { id: '1', number: 1, status: 'PUBLISHED' },
  versions: [{ id: '1', number: 1, status: 'PUBLISHED' }],
};

const renderScreen = () => render(createElement(SprayWallResetScreen, { wallUuid: 'wall-1' }));

beforeEach(() => {
  Object.values(targetMocks).forEach((mock) => mock.mockReset());
  markerProps.current = null;
  discardMutateAsync.mockClear();
  pickResult.current = { outcome: 'picked', photo: { uri: 'file:///w.jpg', width: 2048, height: 1536 } };
  wallQueryState.current = { data: EDITABLE_WALL, isPending: false };
});

describe('SprayWallResetScreen', () => {
  it('spins while the wall resolves', () => {
    wallQueryState.current = { data: null, isPending: true };
    expect(renderScreen().getByTestId('spinner')).toBeTruthy();
  });

  it('refuses a wall the viewer may not edit', () => {
    wallQueryState.current = { data: { ...EDITABLE_WALL, viewerCanEdit: false }, isPending: false };
    expect(renderScreen().getByText('sprayReset.notYours')).toBeTruthy();
  });

  it('refuses a wall with nothing published — there is no generation to supersede', () => {
    wallQueryState.current = { data: { ...EDITABLE_WALL, currentVersion: null }, isPending: false };
    expect(renderScreen().getByText('sprayReset.nothingPublished')).toBeTruthy();
  });

  it('offers to discard an abandoned draft without valid photo dimensions', async () => {
    wallQueryState.current = {
      data: { ...EDITABLE_WALL, versions: [{ id: '2', number: 2, status: 'DRAFT' }, ...EDITABLE_WALL.versions] },
      isPending: false,
    };
    const { getByText } = renderScreen();

    expect(getByText('sprayReset.openDraft.title')).toBeTruthy();
    await act(async () => {
      getByText('sprayReset.openDraft.discard').click();
    });
    expect(discardMutateAsync).toHaveBeenCalledWith('2');
  });

  it('resumes the existing reset detection without manual fallback or changing the published wall', async () => {
    wallQueryState.current = {
      data: {
        ...EDITABLE_WALL,
        versions: [
          { id: '2', number: 2, status: 'DRAFT', photo: { width: 800, height: 600 } },
          ...EDITABLE_WALL.versions,
        ],
      },
      isPending: false,
    };
    const { getByText, getByTestId } = renderScreen();
    await act(async () => getByText('sprayDetection.resume').click());
    expect(getByTestId('detection').getAttribute('data-wall')).toBe('wall-1');
    expect(getByTestId('detection').getAttribute('data-version')).toBe('2');
    expect(getByTestId('detection').getAttribute('data-manual')).toBe('false');
    expect(discardMutateAsync).not.toHaveBeenCalled();
    expect(EDITABLE_WALL.currentVersion.id).toBe('1');
  });

  it('opens on the photo step', () => {
    const { getByText } = renderScreen();
    expect(getByText('sprayReset.photo.title')).toBeTruthy();
    // Nothing to go on with until a photo is chosen.
    expect(getByText('sprayWizard.photo.next').getAttribute('data-disabled')).toBe('true');
  });

  it('holds the anchors gate shut until four corners are set', async () => {
    const { getByText, getByTestId } = renderScreen();

    await act(async () => {
      getByText('sprayWizard.photo.library').click();
    });
    act(() => getByText('sprayWizard.photo.next').click());

    // THE gate. Without anchors the identity homography claims this photograph
    // has version 1's crop, and the matcher reports the whole wall as removed.
    expect(getByText('sprayReset.anchors.title')).toBeTruthy();
    expect(getByTestId('corner-marker')).toBeTruthy();
    expect(getByText('sprayReset.anchors.use').getAttribute('data-disabled')).toBe('true');

    act(() => markerProps.current?.onChange?.(SQUARE));
    expect(getByText('sprayReset.anchors.use').getAttribute('data-disabled')).toBe('false');
  });

  it('keeps the gate shut for corners that cross over each other', async () => {
    const { getByText } = renderScreen();

    await act(async () => {
      getByText('sprayWizard.photo.library').click();
    });
    act(() => getByText('sprayWizard.photo.next').click());
    act(() =>
      markerProps.current?.onChange?.([
        [0, 0],
        [100, 0],
        [0, 100],
        [100, 100],
      ]),
    );

    expect(getByText('sprayReset.anchors.notConvex')).toBeTruthy();
    expect(getByText('sprayReset.anchors.use').getAttribute('data-disabled')).toBe('true');
  });

  it('survives a cancelled picker without leaving the photo step', async () => {
    pickResult.current = { outcome: 'cancelled' };
    const { getByText } = renderScreen();

    await act(async () => {
      getByText('sprayWizard.photo.library').click();
    });

    expect(getByText('sprayReset.photo.title')).toBeTruthy();
    expect(getByText('sprayWizard.photo.next').getAttribute('data-disabled')).toBe('true');
  });
});

afterEach(cleanup);

describe('targeted spray import resume', () => {
  it('automatically resumes the exact reset version without creating or discarding a draft', () => {
    wallQueryState.current = {
      data: {
        ...EDITABLE_WALL,
        versions: [
          { id: '42', number: 2, status: 'DRAFT', photo: { width: 800, height: 600 } },
          ...EDITABLE_WALL.versions,
        ],
      },
      isPending: false,
    };
    const { getByTestId } = render(createElement(SprayWallResetScreen, { wallUuid: 'wall-1', versionId: '42' }));
    expect(getByTestId('detection').getAttribute('data-version')).toBe('42');
    expect(targetMocks.createVersion).not.toHaveBeenCalled();
    expect(discardMutateAsync).not.toHaveBeenCalled();
    expect(EDITABLE_WALL.currentVersion.id).toBe('1');
  });

  it('refuses a stale reset version instead of adopting a different open draft', () => {
    wallQueryState.current = {
      data: {
        ...EDITABLE_WALL,
        versions: [
          { id: '43', number: 2, status: 'DRAFT', photo: { width: 800, height: 600 } },
          ...EDITABLE_WALL.versions,
        ],
      },
      isPending: false,
    };
    const { getByText, queryByTestId } = render(
      createElement(SprayWallResetScreen, { wallUuid: 'wall-1', versionId: '42' }),
    );
    expect(getByText('sprayImport.unavailable')).toBeTruthy();
    expect(queryByTestId('detection')).toBeNull();
    expect(targetMocks.createVersion).not.toHaveBeenCalled();
    expect(discardMutateAsync).not.toHaveBeenCalled();
  });

  it('opens saved new-wall edits directly on the exact version without restarting detection or creating a wall', async () => {
    targetMocks.fetchWall.mockResolvedValue({
      uuid: 'wall-1',
      layoutId: 9001,
      viewerCanEdit: true,
      board: { uuid: 'wall-1', name: 'Saved garage' },
      currentVersion: null,
      versions: [
        { id: '42', number: 1, status: 'DRAFT', photo: { url: 'https://photo.invalid/saved.jpg' }, addedHoldCount: 17 },
      ],
    });
    const { getByTestId, queryByTestId } = render(
      createElement(SprayWallWizardScreen, { returnTo: '/(tabs)/climbs', wallUuid: 'wall-1', versionId: '42' }),
    );
    await waitFor(() => expect(getByTestId('hold-editor').getAttribute('data-version')).toBe('42'));
    expect(getByTestId('hold-editor').getAttribute('data-wall')).toBe('wall-1');
    expect(getByTestId('hold-editor').getAttribute('data-candidate-count')).toBe('0');
    expect(queryByTestId('detection')).toBeNull();
    expect(targetMocks.fetchWall).toHaveBeenCalledWith('wall-1');
    expect(targetMocks.createWall).not.toHaveBeenCalled();
    expect(targetMocks.createVersion).not.toHaveBeenCalled();
  });

  it('opens an already-published notification target as its board without creating another wall', async () => {
    const publishedBoard = { uuid: 'wall-1', name: 'Published garage' };
    targetMocks.fetchWall.mockResolvedValue({
      uuid: 'wall-1',
      layoutId: 9001,
      viewerCanEdit: true,
      board: publishedBoard,
      currentVersion: { id: '42' },
      versions: [{ id: '42', number: 1, status: 'PUBLISHED' }],
    });
    render(createElement(SprayWallWizardScreen, { returnTo: '/(tabs)/climbs', wallUuid: 'wall-1', versionId: '42' }));
    await waitFor(() => expect(targetMocks.finish).toHaveBeenCalledWith(publishedBoard));
    expect(targetMocks.createWall).not.toHaveBeenCalled();
    expect(targetMocks.createVersion).not.toHaveBeenCalled();
  });

  it('rejects a stale new-wall version rather than resuming another draft or creating a wall', async () => {
    targetMocks.fetchWall.mockResolvedValue({
      uuid: 'wall-1',
      layoutId: 9001,
      viewerCanEdit: true,
      board: { uuid: 'wall-1', name: 'Saved garage' },
      currentVersion: null,
      versions: [
        { id: '43', number: 1, status: 'DRAFT', photo: { url: 'https://photo.invalid/saved.jpg' }, addedHoldCount: 17 },
      ],
    });
    const { getByText, queryByTestId } = render(
      createElement(SprayWallWizardScreen, { returnTo: '/(tabs)/climbs', wallUuid: 'wall-1', versionId: '42' }),
    );
    await waitFor(() => expect(getByText('sprayImport.unavailable')).toBeTruthy());
    expect(queryByTestId('hold-editor')).toBeNull();
    expect(queryByTestId('detection')).toBeNull();
    expect(targetMocks.createWall).not.toHaveBeenCalled();
    expect(targetMocks.createVersion).not.toHaveBeenCalled();
  });
});
