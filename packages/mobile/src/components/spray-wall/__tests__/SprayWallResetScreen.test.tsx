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

const wallQueryState = vi.hoisted(() => ({
  current: { data: null, isPending: false } as { data: unknown; isPending: boolean; isFetching?: boolean },
}));
const pickResult = vi.hoisted(() => ({
  current: { outcome: 'picked', photo: { uri: 'file:///w.jpg', width: 2048, height: 1536 } } as unknown,
}));
const discardMutateAsync = vi.hoisted(() => vi.fn(async () => true));
const createMutateAsync = vi.hoisted(() => vi.fn());
const refetchWall = vi.hoisted(() => vi.fn());
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

// Native provider behavior is exercised by use-spray-leave-guard.test.tsx.
vi.mock('../use-spray-leave-guard', () => ({ useSprayLeaveGuard: vi.fn() }));
vi.mock('expo-image', () => ({ Image: () => createElement('img', { 'data-testid': 'preview' }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
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
  extractGraphqlCode: (error: unknown) => (error as { extensions?: { code?: string } })?.extensions?.code,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
type ButtonMockProps = {
  title: string;
  onPress?: () => void;
  disabled?: boolean;
  variant?: string;
  size?: string;
  role?: string;
};
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled, variant, size, role }: ButtonMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        disabled,
        'data-disabled': disabled ? 'true' : 'false',
        'data-variant': variant ?? 'default',
        'data-size': size ?? 'default',
        'data-role': role ?? '',
      },
      title,
    ),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('i', { 'data-testid': 'spinner' }),
}));
// The step's body is stubbed (it only draws once its slot has been measured,
// and nothing here lays out). Its footer is real: the gate lives on it.
vi.mock('../SprayCornerStep', () => ({
  SprayCornerStep: (props: { title: string; invalid: boolean; onChange?: (quad: unknown) => void }) => {
    markerProps.current = props;
    return createElement(
      'div',
      { 'data-testid': 'corner-marker', 'data-invalid': props.invalid ? 'true' : 'false' },
      props.title,
    );
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
  useCreateSprayWallVersion: () => ({ mutateAsync: createMutateAsync }),
}));
vi.mock('../../../lib/spray/use-spray-wall-reset', () => ({
  useSprayWallWithVersions: () => ({ ...wallQueryState.current, refetch: refetchWall }),
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
  createMutateAsync.mockReset();
  refetchWall.mockReset();
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

  // #5960: Resume was drawn smaller than the destructive discard under it.
  it('makes Resume the primary action and the discard a destructive text button', () => {
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
    const { getByText } = renderScreen();
    const resume = getByText('sprayDetection.resume');
    expect(resume.getAttribute('data-variant')).toBe('filled');
    expect(resume.getAttribute('data-size')).toBe('large');
    const discard = getByText('sprayReset.openDraft.discard');
    expect(discard.getAttribute('data-variant')).toBe('text');
    expect(discard.getAttribute('data-role')).toBe('destructive');
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

  it('shows "start the corners again" before there are corners, so the footer never grows', async () => {
    const { getByText } = renderScreen();

    await act(async () => {
      getByText('sprayWizard.photo.library').click();
    });
    act(() => getByText('sprayWizard.photo.next').click());

    // The photo is fitted to the space the footer leaves. A button that only
    // appeared after the first drag made the footer taller at that moment and
    // put the bottom two rings under it (#5958).
    expect(getByText('sprayWizard.anchors.clear').getAttribute('data-disabled')).toBe('true');

    act(() => markerProps.current?.onChange?.(SQUARE));
    expect(getByText('sprayWizard.anchors.clear').getAttribute('data-disabled')).toBe('false');
  });

  it('keeps the gate shut for corners that cross over each other', async () => {
    const { getByText, getByTestId } = renderScreen();

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

    // The step says why, in the slot its hint lives in; the screen's part is the flag.
    expect(getByTestId('corner-marker').getAttribute('data-invalid')).toBe('true');
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

describe('reset draft ownership and retry identity', () => {
  it('routes a hold-edit draft back to Edit holds without offering reset detection', () => {
    const photo = { url: 'https://private.example/spray-walls/aaaa/bbbb.jpg?signature=one', width: 800, height: 600 };
    const geometry = { photo, anchors: null, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    wallQueryState.current = {
      data: {
        ...EDITABLE_WALL,
        currentVersion: { ...EDITABLE_WALL.currentVersion, ...geometry },
        versions: [{ id: '2', number: 2, status: 'DRAFT', ...geometry }],
      },
      isPending: false,
    };
    const mounted = renderScreen();
    expect(mounted.getByText('sprayReset.openDraft.holdEditTitle')).toBeTruthy();
    expect(mounted.queryByText('sprayDetection.resume')).toBeNull();
    expect(mounted.queryByText('sprayReset.openDraft.discard')).toBeNull();
  });

  it('retries the same uploaded object after a lost create response', async () => {
    const { uploadSprayWallPhoto } = await import('../../../lib/spray/spray-wall-photo-upload');
    vi.mocked(uploadSprayWallPhoto)
      .mockReset()
      .mockResolvedValue({ photoId: 'chosen-photo', width: 800, height: 600, determinate: true });
    createMutateAsync.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ id: '2', number: 2 });
    const mounted = renderScreen();
    await act(async () => mounted.getByText('sprayWizard.photo.library').click());
    act(() => mounted.getByText('sprayWizard.photo.next').click());
    act(() => markerProps.current?.onChange?.(SQUARE));
    await act(async () => mounted.getByText('sprayReset.anchors.use').click());
    await act(async () => mounted.getByText('sprayWizard.upload.retry').click());
    expect(uploadSprayWallPhoto).toHaveBeenCalledTimes(1);
    expect(createMutateAsync).toHaveBeenCalledTimes(2);
    expect(createMutateAsync.mock.calls[1]?.[0]).toEqual(createMutateAsync.mock.calls[0]?.[0]);
    expect(createMutateAsync.mock.calls[1]?.[0].photoId).toBe('chosen-photo');
    expect(mounted.getByTestId('detection').getAttribute('data-version')).toBe('2');
  });

  it('offers explicit recovery when an older draft blocks the chosen photo', async () => {
    const { uploadSprayWallPhoto } = await import('../../../lib/spray/spray-wall-photo-upload');
    vi.mocked(uploadSprayWallPhoto)
      .mockReset()
      .mockResolvedValue({ photoId: 'chosen-photo', width: 800, height: 600, determinate: true });
    createMutateAsync.mockRejectedValue({ extensions: { code: 'SPRAY_WALL_DRAFT_ALREADY_OPEN' } });
    refetchWall.mockImplementation(async () => {
      wallQueryState.current = {
        data: {
          ...EDITABLE_WALL,
          versions: [{ id: 'older', number: 2, status: 'DRAFT', photo: { width: 800, height: 600 } }],
        },
        isPending: false,
      };
    });
    const mounted = renderScreen();
    await act(async () => mounted.getByText('sprayWizard.photo.library').click());
    act(() => mounted.getByText('sprayWizard.photo.next').click());
    act(() => markerProps.current?.onChange?.(SQUARE));
    await act(async () => mounted.getByText('sprayReset.anchors.use').click());
    expect(mounted.getByText('sprayReset.openDraft.title')).toBeTruthy();
    expect(mounted.queryByTestId('detection')).toBeNull();
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    await act(async () => mounted.getByText('sprayDetection.resume').click());
    expect(mounted.getByTestId('detection').getAttribute('data-version')).toBe('older');
  });
});

describe('fresh history and discard recovery', () => {
  it('waits for fresh history before offering cached draft actions', () => {
    wallQueryState.current = {
      data: { ...EDITABLE_WALL, versions: [{ id: 'stale', number: 2, status: 'DRAFT' }] },
      isPending: false,
      isFetching: true,
    };
    const mounted = renderScreen();
    expect(mounted.getByTestId('spinner')).toBeTruthy();
    expect(mounted.queryByText('sprayDetection.resume')).toBeNull();
    wallQueryState.current = { data: EDITABLE_WALL, isPending: false, isFetching: false };
    mounted.rerender(createElement(SprayWallResetScreen, { wallUuid: 'wall-1' }));
    expect(mounted.queryByTestId('spinner')).toBeNull();
    expect(mounted.getByText('sprayWizard.photo.next')).toBeTruthy();
  });

  it('discards a conflicting draft and retries with the chosen photo upload', async () => {
    const { uploadSprayWallPhoto } = await import('../../../lib/spray/spray-wall-photo-upload');
    vi.mocked(uploadSprayWallPhoto).mockReset().mockResolvedValue({
      photoId: 'chosen-photo',
      width: 800,
      height: 600,
      determinate: true,
    });
    createMutateAsync
      .mockRejectedValueOnce({ extensions: { code: 'SPRAY_WALL_DRAFT_ALREADY_OPEN' } })
      .mockResolvedValueOnce({ id: 'replacement', number: 2 });
    refetchWall.mockImplementation(async () => {
      wallQueryState.current = {
        data: { ...EDITABLE_WALL, versions: [{ id: 'older', number: 2, status: 'DRAFT' }] },
        isPending: false,
      };
    });
    discardMutateAsync.mockImplementationOnce(async () => {
      wallQueryState.current = { data: EDITABLE_WALL, isPending: false };
      return true;
    });
    const mounted = renderScreen();
    await act(async () => mounted.getByText('sprayWizard.photo.library').click());
    act(() => mounted.getByText('sprayWizard.photo.next').click());
    act(() => markerProps.current?.onChange?.(SQUARE));
    await act(async () => mounted.getByText('sprayReset.anchors.use').click());
    await act(async () => mounted.getByText('sprayReset.openDraft.discard').click());
    expect(discardMutateAsync).toHaveBeenCalledWith('older');
    expect(mounted.getByText('sprayWizard.photo.next').getAttribute('data-disabled')).toBe('false');
    act(() => mounted.getByText('sprayWizard.photo.next').click());
    act(() => markerProps.current?.onChange?.(SQUARE));
    await act(async () => mounted.getByText('sprayReset.anchors.use').click());
    expect(uploadSprayWallPhoto).toHaveBeenCalledTimes(1);
    expect(createMutateAsync).toHaveBeenCalledTimes(2);
    expect(createMutateAsync.mock.calls[1]?.[0]).toEqual(createMutateAsync.mock.calls[0]?.[0]);
    expect(mounted.getByTestId('detection').getAttribute('data-version')).toBe('replacement');
  });
});
