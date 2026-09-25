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

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const wallQueryState = vi.hoisted(() => ({ current: { data: null as unknown, isPending: false } }));
const pickResult = vi.hoisted(() => ({
  current: { outcome: 'picked', photo: { uri: 'file:///w.jpg', width: 2048, height: 1536 } } as unknown,
}));
const discardMutateAsync = vi.hoisted(() => vi.fn(async () => true));
/** The corner marker's props, so a test can hand the screen four corners. */
const markerProps = vi.hoisted(() => ({ current: null as null | { onChange?: (quad: unknown) => void } }));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  Platform: { OS: 'ios' },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { hairlineWidth: 1, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('expo-image', () => ({ Image: () => createElement('img', { 'data-testid': 'preview' }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() }),
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
  useCreateSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  fetchSprayWallVersions: vi.fn(),
}));
vi.mock('../../../lib/spray/use-spray-wall-reset', () => ({
  useSprayWallWithVersions: () => wallQueryState.current,
  useDiscardSprayWallVersion: () => ({ mutateAsync: discardMutateAsync, isPending: false }),
}));

const { SprayWallResetScreen } = await import('../SprayWallResetScreen');

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
