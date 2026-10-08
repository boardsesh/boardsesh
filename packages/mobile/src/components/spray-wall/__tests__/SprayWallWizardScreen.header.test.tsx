// @vitest-environment jsdom
//
// The wizard's header against the REAL `useHeaderActions`, writing into a
// recording `navigation.setOptions`. The other wizard suites stub the hook; this
// one pins the hand-offs between the wizard and the steps that own part of the
// header themselves:
//
//  - the crop step sets its own Cancel and Done, and the wizard does not write
//    over either side while it shows;
//  - the look step sets its own confirm, and moving on to the publish clears it
//    (the hook never clears a slot, so the wizard has to).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';

type HeaderSlot = (props: { tintColor?: string }) => ReactElement<Record<string, unknown>>;
type Options = { headerLeft?: HeaderSlot; headerRight?: HeaderSlot; title?: string };

const setOptionsMock = vi.hoisted(() => vi.fn<(options: Options) => void>());
const navigation = vi.hoisted(() => ({
  getParent: () => undefined,
  setOptions: (options: Options) => setOptionsMock(options),
}));
const routerMock = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), canGoBack: () => true }));
const alertMock = vi.hoisted(() => vi.fn());
const fetchVersionsMock = vi.hoisted(() => vi.fn());
const pickLibraryMock = vi.hoisted(() => vi.fn());
const wallsQuery = vi.hoisted(() => ({ current: { data: [] as unknown, isFetching: false, dataUpdatedAt: 0 } }));
const stepProps = vi.hoisted(() => ({
  editor: null as null | { onCommitted: (summary: unknown) => void },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Alert: { alert: alertMock },
  BackHandler: { addEventListener: () => ({ remove() {} }) },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  Platform: { OS: 'ios' },
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { hairlineWidth: 1, absoluteFillObject: {}, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useNavigation: () => navigation,
  useFocusEffect: () => {},
}));
// The hook is real; only the bar items it builds are stand-ins, so a test can
// read what each slot holds from the element's props.
vi.mock('../../HeaderActionButtons', () => ({
  HeaderLeadingButton: () => null,
  HeaderTrailingGroup: () => null,
}));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../../hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
const stableQueryClient = vi.hoisted(() => ({}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => stableQueryClient }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en-US', language: 'en-US' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemBlue: '#007AFF', systemRed: '#FF3B30' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888', tertiaryLabel: '#666', separator: '#222' } }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {},
  sprayHoldsReviewed: () => ({ name: 'r', properties: {} }),
  sprayWallPhotoPicked: () => ({ name: 'p', properties: {} }),
  sprayWallUploadFinished: () => ({ name: 'u', properties: {} }),
}));
vi.mock('../../../lib/spray/spray-telemetry', () => ({ trackSprayEvent: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn(), addErrorBreadcrumb: vi.fn() }));
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: () => undefined,
  extractGraphqlCode: () => undefined,
  sprayWallLifecycleRefusal: () => null,
}));
vi.mock('../../../lib/spray/spray-lifecycle-copy', () => ({ sprayWallLifecycleMessage: (refusal: string) => refusal }));
vi.mock('../../../lib/spray/settle-archived-spray-wall', () => ({ settleArchivedSprayWall: vi.fn() }));
const stableActivateBoard = vi.hoisted(() => () => {});
vi.mock('../../../lib/boards/use-activate-board', () => ({ useActivateBoard: () => stableActivateBoard }));
vi.mock('../../../lib/spray/activate-published-spray-wall', () => ({ activatePublishedSprayWall: vi.fn() }));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({
  invalidateSprayWallRenderData: vi.fn(),
  fetchSprayWallResetSource: async () => null,
}));
vi.mock('../../../lib/spray/use-spray-wall-draft', () => ({ prefetchSprayWallDraft: vi.fn() }));
vi.mock('../../../lib/spray/spray-wall-photo-upload', () => ({ uploadSprayWallPhoto: vi.fn() }));
vi.mock('../../../lib/spray/camera-capability', () => ({ canPhotographWall: () => false }));
vi.mock('../../../lib/spray/wall-photo', () => ({
  WALL_PHOTO_MAX_DIMENSION: 4096,
  pickWallPhotoFromLibrary: pickLibraryMock,
  pickWallPhotoFromCamera: vi.fn(),
  renderWallPhotoEdit: vi.fn(),
  renderRotatedPreview: vi.fn(),
  rescalePoint: (point: [number, number]) => point,
}));
vi.mock('../../../lib/spray/discard-local-photo', () => ({ discardLocalPhoto: vi.fn() }));
// A publish that never answers: the run stays on the publish step.
const pendingPublish = vi.hoisted(() => () => new Promise<never>(() => {}));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  fetchSprayWallVersions: fetchVersionsMock,
  useMySprayWalls: () => ({ ...wallsQuery.current, errorUpdatedAt: 0, refetch: vi.fn() }),
  useCreateSprayWall: () => ({ mutateAsync: vi.fn() }),
  useCreateSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  usePublishSprayWallVersion: () => ({ mutateAsync: pendingPublish }),
  useUpdateSprayWallVisibility: () => ({ mutateAsync: vi.fn() }),
  useDiscardSprayWallDraft: () => ({ mutateAsync: vi.fn() }),
  useResetSprayWall: () => ({ mutateAsync: vi.fn() }),
  useMySprayWallLifecycle: () => ({
    data: [{ uuid: 'wall-1', layoutId: 7, archivedAt: null, resetOfWallUuid: null, board: null }],
    isFetching: false,
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('i') }));
vi.mock('../../board-discovery/GymPickerSheet', () => ({ GymPickerSheet: () => null }));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  BoardIdentityFields: () => createElement('div', { 'data-testid': 'identity' }),
  BoardVisibilityFields: () => null,
  SectionLabel: () => null,
  SprayWallVisibilityField: () => null,
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivityField: () => null }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({ getConnectivitySnapshot: () => ({ reason: null }) }));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../SprayCornerStep', () => ({ SprayCornerStep: () => null }));
vi.mock('../SprayCropMarker', () => ({ SprayCropMarker: () => createElement('div', { 'data-testid': 'crop' }) }));
vi.mock('../SprayDetectionStep', () => ({ SprayDetectionStep: () => null }));
vi.mock('../../outline-editor/SprayHoldEditorScreen', () => ({
  confirmDiscardSprayEdits: vi.fn(),
  SprayHoldEditorScreen: (props: { onCommitted: (summary: unknown) => void }) => {
    stepProps.editor = props;
    return createElement('div', { 'data-testid': 'editor' });
  },
}));
// The look step, cut down to the part under test: it sets its confirm through
// the real hook, the way SprayWallLookStep does.
vi.mock('../SprayWallLookStep', async () => {
  const { useHeaderActions } = await import('../../../hooks/use-header-actions');
  return {
    SprayWallLookStep: ({ onConfirmed }: { onConfirmed: () => void }) => {
      useHeaderActions({ trailing: { label: 'look.confirm', onPress: onConfirmed, prominent: true } });
      return createElement('div', { 'data-testid': 'look' });
    },
  };
});
vi.mock('../use-spray-wizard-leave-guard', () => ({ useSprayWizardLeaveGuard: () => {} }));

const { SprayWallWizardScreen } = await import('../SprayWallWizardScreen');

/** Every `setOptions` call that wrote `key`, in order. */
function writesOf(key: keyof Options): Options[] {
  return setOptionsMock.mock.calls.map(([options]) => options).filter((options) => key in options);
}

/** The props of the bar item the last write of `key` would draw. */
function lastSlotProps(key: 'headerLeft' | 'headerRight'): Record<string, unknown> | undefined {
  return writesOf(key).at(-1)?.[key]?.({})?.props;
}

/** What the header's trailing confirm says right now. */
function trailingLabel(): string | undefined {
  return (lastSlotProps('headerRight')?.trailing as { label?: string } | undefined)?.label;
}

/** Press the header's trailing confirm as it stands. */
function pressTrailing() {
  const trailing = lastSlotProps('headerRight')?.trailing as { onPress: () => void } | undefined;
  act(() => trailing?.onPress());
}

const PHOTO = {
  uri: 'file:///wall.jpg',
  width: 4032,
  height: 3024,
  base: { uri: 'file:///wall.jpg', width: 4032, height: 3024 },
  original: { uri: 'file:///wall.heic', longSide: 4032 },
  edit: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  wallsQuery.current = { data: [], isFetching: false, dataUpdatedAt: Date.now() + 60_000 };
  stepProps.editor = null;
});
afterEach(cleanup);

describe('the wizard header, with the real useHeaderActions', () => {
  it('leaves Cancel and Done to the crop step, and takes the header back after it', async () => {
    render(createElement(SprayWallWizardScreen, { returnTo: '/(tabs)/climbs' }));
    expect(screen.getByTestId('identity')).toBeTruthy();
    expect(lastSlotProps('headerLeft')?.kind).toBe('close');

    pressTrailing();
    expect(screen.getByText('sprayWizard.photo.title')).toBeTruthy();
    pickLibraryMock.mockResolvedValueOnce({ outcome: 'picked', photo: PHOTO });
    await act(async () => fireEvent.click(screen.getByText('sprayWizard.photo.library')));

    const writesBeforeCrop = setOptionsMock.mock.calls.length;
    fireEvent.click(screen.getByText('sprayWizard.photo.adjust'));
    expect(screen.getByTestId('crop')).toBeTruthy();

    // Everything written while the crop step shows is the crop step's own.
    const cropWrites = setOptionsMock.mock.calls.slice(writesBeforeCrop).map(([options]) => options);
    expect(cropWrites.some((options) => 'headerRight' in options && options.headerRight === undefined)).toBe(false);
    expect(lastSlotProps('headerLeft')?.kind).toBe('cancel');
    const done = lastSlotProps('headerRight')?.trailing as { label: string; onPress: () => void };
    expect(done.label).toBe('sprayWizard.adjust.done');

    // Done with nothing changed is Cancel: back on the photo, with its chevron and Next.
    act(() => done.onPress());
    expect(screen.getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(lastSlotProps('headerLeft')?.kind).toBe('back');
    expect(trailingLabel()).toBe('sprayWizard.photo.next');
  });

  it("clears the look step's confirm once the publish starts", async () => {
    wallsQuery.current = {
      data: [
        { uuid: 'wall-1', layoutId: 7, viewerCanEdit: true, board: { name: 'Garage wall' }, currentVersion: null },
      ],
      isFetching: false,
      dataUpdatedAt: Date.now() + 60_000,
    };
    fetchVersionsMock.mockResolvedValue({
      uuid: 'wall-1',
      layoutId: 7,
      viewerCanEdit: true,
      board: { name: 'Garage wall' },
      currentVersion: null,
      versions: [{ id: 'v-1', number: 1, status: 'DRAFT', photo: { url: 'https://img/w.jpg' }, addedHoldCount: 2 }],
    });
    render(createElement(SprayWallWizardScreen, { returnTo: '/(tabs)/climbs' }));
    await act(async () => {});
    const pickUp = (alertMock.mock.calls.at(-1)?.[2] as { text: string; onPress: () => void }[] | undefined)?.find(
      (button) => button.text === 'sprayWizard.resume.pickUp',
    );
    await act(async () => pickUp?.onPress());
    expect(screen.getByTestId('editor')).toBeTruthy();

    act(() => stepProps.editor?.onCommitted({ written: 0, removed: 0, holdCount: 2 }));
    expect(screen.getByTestId('look')).toBeTruthy();
    expect(trailingLabel()).toBe('look.confirm');

    pressTrailing();
    await act(async () => {});
    expect(screen.getByText('sprayWizard.publish.title')).toBeTruthy();
    const lastRight = writesOf('headerRight').at(-1);
    expect(lastRight).toEqual({ headerRight: undefined });
    expect(lastSlotProps('headerLeft')?.kind).toBe('close');
  });
});
