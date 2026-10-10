// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
//
// The add-a-wall wizard, mounted (epic #5346, SW-09b).
//
// The pure pieces are covered elsewhere (`resume-draft`, `add-wall-machine`, and
// the native hook in `use-spray-wizard-leave-guard`). What none of them can see
// is the wiring inside the screen, and two guards live only there:
//
//  - the resume question waits for a `mySprayWalls` fetch that SETTLED after
//    this screen mounted. A cached empty list served while a refetch runs would
//    otherwise latch the prompt away and let the flow create a second wall;
//  - every way out hands `confirmLeave` to the native guard, so the swipe, the
//    header X and Android Back all ask the same question;
//  - the header shows the step's way back or out and its forward action.
//
// The guard hook is stubbed to capture `confirmLeave`; its own contract is
// pinned by use-spray-wizard-leave-guard.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type WallsQuery = {
  data: unknown;
  isFetching: boolean;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
};

const wallsQuery = vi.hoisted(() => ({
  current: { data: undefined, isFetching: true, dataUpdatedAt: 0, errorUpdatedAt: 0 } as WallsQuery,
}));
const alertMock = vi.hoisted(() => vi.fn());
const fetchVersionsMock = vi.hoisted(() => vi.fn());
const guard = vi.hoisted(() => ({ confirmLeave: null as null | ((onConfirm: () => void) => void) }));
const editorProps = vi.hoisted(() => ({
  last: null as null | { onDirtyChange?: (dirty: boolean) => void; onHandoverChange?: (handingOver: boolean) => void },
}));
const confirmDiscardMock = vi.hoisted(() => vi.fn());
const resetWallMock = vi.hoisted(() => vi.fn());
const createWallMock = vi.hoisted(() => vi.fn());
/** The builder the name step hands its identity fields, so a test can name the wall. */
const identityFields = vi.hoisted(() => ({ builder: null as null | { setName: (next: string) => void } }));
const discardDraftMock = vi.hoisted(() => vi.fn(async () => true));
const routerMock = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  dismissTo: vi.fn(),
  canGoBack: vi.fn(() => true),
}));
/** What the screen last put in its header, through `useHeaderActions`. */
type HeaderLeading = { kind: string; onPress: () => void; disabled?: boolean } | null | undefined;
type HeaderTrailing =
  | { label: string; onPress: () => void; disabled?: boolean; loading?: boolean; prominent?: boolean }
  | null
  | undefined;
const header = vi.hoisted(() => ({
  leading: null as HeaderLeading,
  trailing: null as HeaderTrailing,
  accessory: null as unknown,
}));
const setOptionsMock = vi.hoisted(() => vi.fn());
/** The fail-soft lifecycle list: which walls are a reset's clone. */
const lifecycleQuery = vi.hoisted(() => ({
  current: { data: undefined as unknown, isFetching: false },
}));
/** The `enabled` flag each list hook was called with, per render. */
const listEnabled = vi.hoisted(() => ({ walls: [] as unknown[], lifecycle: [] as unknown[] }));
/** Android Back: the focus effect the screen registers, and the handler it adds. */
const hardwareBack = vi.hoisted(() => ({
  focusEffect: null as null | (() => void | (() => void)),
  handler: null as null | (() => boolean),
  adjustProps: null as null | { onDone: (edit: unknown) => void },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { isReduceMotionEnabled: vi.fn(async () => false), addEventListener: () => ({ remove() {} }) },
  Alert: { alert: alertMock },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      hardwareBack.handler = handler;
      return {
        remove: () => {
          hardwareBack.handler = null;
        },
      };
    },
  },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  Platform: { OS: 'ios' },
  Pressable: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    hairlineWidth: 1,
    absoluteFillObject: {},
    create: (styles: unknown) => styles,
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useNavigation: () => ({ getParent: () => undefined, setOptions: setOptionsMock }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    hardwareBack.focusEffect = effect;
  },
}));
// Records what the screen asks for, the way the real hook writes it: a slot
// left out keeps its last value, and the right side (confirm plus accessory)
// is written whole whenever either is passed. A test with the real hook is
// SprayWallWizardScreen.header.test.tsx.
vi.mock('../../../hooks/use-header-actions', () => ({
  ownHeaderRight: (headerRight: unknown) => ({ headerRight, unstable_headerRightItems: undefined }),
  useHeaderActions: (actions: { leading?: HeaderLeading; trailing?: HeaderTrailing; trailingAccessory?: unknown }) => {
    if (actions.leading) header.leading = actions.leading;
    if (actions.trailing || actions.trailingAccessory != null) {
      header.trailing = actions.trailing ?? null;
      header.accessory = actions.trailingAccessory ?? null;
    }
  },
}));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
const stableQueryClient = vi.hoisted(() => ({}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => stableQueryClient }));
// `t` is stable across renders, as in the app: the targeted-open effect lists it
// as a dependency, so a fresh function per render would refetch on every render.
const stableT = vi.hoisted(() => (key: string) => key);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT, i18n: { resolvedLanguage: 'en-US', language: 'en-US' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemBlue: '#007AFF', systemRed: '#FF3B30' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { background: '#000', secondaryLabel: '#888', tertiaryLabel: '#666', separator: '#222' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {},
  sprayHoldsReviewed: () => ({ name: 'r', properties: {} }),
  sprayWallPhotoPicked: () => ({ name: 'p', properties: {} }),
  sprayWallUploadFinished: () => ({ name: 'u', properties: {} }),
}));
const trackSprayMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/spray/spray-telemetry', () => ({ trackSprayEvent: trackSprayMock }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
// The photo step's shooting-guide link (#6141). The real module loads
// expo-web-browser, whose native event emitter does not exist under node.
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: () => undefined,
  extractGraphqlCode: () => undefined,
  // A test error names its refusal directly; the real code mapping has its own suite.
  sprayWallLifecycleRefusal: (error: unknown) => (error as { refusal?: string } | null)?.refusal ?? null,
}));
vi.mock('../../../lib/spray/spray-lifecycle-copy', () => ({
  sprayWallLifecycleMessage: (refusal: string) => `lifecycle:${refusal}`,
}));
vi.mock('../../../lib/spray/settle-archived-spray-wall', () => ({ settleArchivedSprayWall: vi.fn() }));
const stableActivateBoard = vi.hoisted(() => () => {});
vi.mock('../../../lib/boards/use-activate-board', () => ({ useActivateBoard: () => stableActivateBoard }));
vi.mock('../../../lib/spray/activate-published-spray-wall', () => ({ activatePublishedSprayWall: vi.fn() }));
const resetSourceMock = vi.hoisted(() => vi.fn(async (): Promise<string | null | undefined> => undefined));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({
  invalidateSprayWallRenderData: vi.fn(),
  fetchSprayWallResetSource: resetSourceMock,
}));
vi.mock('../../../lib/spray/use-spray-wall-draft', () => ({ prefetchSprayWallDraft: vi.fn() }));
vi.mock('../../../lib/spray/spray-wall-photo-upload', () => ({ uploadSprayWallPhoto: vi.fn() }));
vi.mock('../../../lib/spray/camera-capability', () => ({ canPhotographWall: () => false }));
vi.mock('../../../lib/spray/wall-photo', () => ({
  pickWallPhotoFromLibrary: vi.fn(),
  pickWallPhotoFromCamera: vi.fn(),
  renderWallPhotoEdit: vi.fn(),
  rescalePoint: (point: [number, number]) => point,
}));
vi.mock('../../../lib/spray/discard-local-photo', () => ({ discardLocalPhoto: vi.fn() }));
// The photo step's guide link opens a browser; the native module behind it does
// not exist outside a device.
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  fetchSprayWallVersions: fetchVersionsMock,
  useMySprayWalls: (options?: { enabled?: boolean }) => {
    listEnabled.walls.push(options?.enabled);
    return { ...wallsQuery.current, refetch: vi.fn() };
  },
  useCreateSprayWall: () => ({ mutateAsync: createWallMock }),
  useCreateSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  usePublishSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  useUpdateSprayWallVisibility: () => ({ mutateAsync: vi.fn() }),
  useDiscardSprayWallDraft: () => ({ mutateAsync: discardDraftMock }),
  useResetSprayWall: () => ({ mutateAsync: resetWallMock }),
  useMySprayWallLifecycle: (options?: { enabled?: boolean }) => {
    listEnabled.lifecycle.push(options?.enabled);
    return lifecycleQuery.current;
  },
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
  BoardIdentityFields: ({ builder }: { builder: { setName: (next: string) => void } }) => {
    identityFields.builder = builder;
    return createElement('div', { 'data-testid': 'identity' });
  },
  BoardVisibilityFields: () => null,
  SectionLabel: () => null,
  SprayWallVisibilityField: () => null,
  SprayTrainingConsentField: ({ value, onValueChange }: { value: boolean; onValueChange: (next: boolean) => void }) =>
    createElement('button', { 'data-testid': 'builder-consent', onClick: () => onValueChange(!value) }),
}));
// Draws for the owner only, as the real row does.
vi.mock('../SprayWallTrainingConsentRow', () => ({
  SprayWallTrainingConsentRow: ({ wallUuid, isOwner }: { wallUuid: string; isOwner: boolean }) =>
    isOwner ? createElement('div', { 'data-testid': 'server-consent' }, wallUuid) : null,
}));
/** Who is driving the flow. The fixtures' walls belong to `me`. */
const viewer = vi.hoisted(() => ({ userId: 'me' as string | null }));
vi.mock('../../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => viewer.userId }));
/** The walls with a training switch flip on the wire, as the mutation cache would answer. */
const consentFlips = vi.hoisted(() => ({ savingFor: new Set<string>() }));
vi.mock('../../../lib/spray/use-spray-wall-training-consent', () => {
  const isSaving = (wallUuid: string | null) => wallUuid != null && consentFlips.savingFor.has(wallUuid);
  return {
    // What a render sees, and what a press reads at the moment it lands.
    useSprayWallTrainingConsentSaving: isSaving,
    isSprayWallTrainingConsentSaving: (_queryClient: unknown, wallUuid: string | null) => isSaving(wallUuid),
  };
});
// Online throughout: the upload-notice wording has its own suite (#5960).
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivityField: () => null }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({ getConnectivitySnapshot: () => ({ reason: null }) }));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../SprayCornerStep', () => ({ SprayCornerStep: () => null }));
vi.mock('../SprayPhotoAdjustStep', () => ({
  SprayPhotoAdjustStep: (props: { onDone: (edit: unknown) => void }) => {
    hardwareBack.adjustProps = props;
    return createElement('div', { 'data-testid': 'crop' });
  },
}));
vi.mock('../SprayDetectionStep', () => ({ SprayDetectionStep: () => null }));
vi.mock('../SprayWallLookStep', () => ({ SprayWallLookStep: () => null }));
vi.mock('../../outline-editor/SprayHoldEditorScreen', () => ({
  confirmDiscardSprayEdits: confirmDiscardMock,
  SprayHoldEditorScreen: (props: {
    onDirtyChange?: (dirty: boolean) => void;
    onHandoverChange?: (handingOver: boolean) => void;
  }) => {
    editorProps.last = props;
    return createElement('div', { 'data-testid': 'editor' });
  },
}));
vi.mock('../use-spray-wizard-leave-guard', () => ({
  useSprayWizardLeaveGuard: (confirmLeave: (onConfirm: () => void) => void) => {
    guard.confirmLeave = confirmLeave;
  },
}));

const { SprayWallWizardScreen } = await import('../SprayWallWizardScreen');

/** A wall the climber walked away from: created, never published. */
const UNFINISHED_WALL = {
  uuid: 'wall-1',
  layoutId: 7,
  viewerCanEdit: true,
  board: { name: 'Garage wall', ownerId: 'me' },
  currentVersion: null,
};

/** The resume flow's second request: the wall with a draft that already has holds on it. */
const WALL_WITH_SAVED_DRAFT = {
  ...UNFINISHED_WALL,
  versions: [{ id: 'v-1', number: 1, status: 'DRAFT', photo: { url: 'https://img/w.jpg' }, addedHoldCount: 2 }],
};

/** Long after any mount, so `dataUpdatedAt > mountedAt` holds. */
const AFTER_MOUNT = () => Date.now() + 60_000;
/** Long before any mount: a list cached by an earlier visit. */
const BEFORE_MOUNT = 1;

function setWalls(next: Partial<WallsQuery>) {
  wallsQuery.current = { ...wallsQuery.current, ...next };
}

function mountWizard() {
  const view = render(<SprayWallWizardScreen returnTo="/(tabs)/climbs" />);
  return { ...view, rerenderWizard: () => view.rerender(<SprayWallWizardScreen returnTo="/(tabs)/climbs" />) };
}

const PICKED_PHOTO = {
  outcome: 'picked',
  photo: {
    uri: 'file:///wall.jpg',
    width: 4032,
    height: 3024,
    base: { uri: 'file:///wall.jpg', width: 4032, height: 3024 },
    original: { uri: 'file:///wall.heic', longSide: 4032 },
    edit: null,
  },
};

/** Pick a photo, so Next is live, and start listening for Android Back. */
async function pickPhotoAndListen(view: { getByText: (text: string) => HTMLElement }) {
  const wallPhoto = await import('../../../lib/spray/wall-photo');
  vi.mocked(wallPhoto.pickWallPhotoFromLibrary).mockResolvedValue(
    PICKED_PHOTO as unknown as Awaited<ReturnType<typeof wallPhoto.pickWallPhotoFromLibrary>>,
  );
  await act(async () => view.getByText('sprayWizard.photo.library').click());
  alertMock.mockClear();
  hardwareBack.focusEffect?.();
}

/** The buttons of the most recent `Alert.alert`, keyed by their label. */
function lastAlertButton(label: string): { onPress: () => void } {
  const buttons = alertMock.mock.calls.at(-1)?.[2] as { text: string; onPress: () => void }[];
  const found = buttons.find((button) => button.text === label);
  if (!found) throw new Error(`no alert button "${label}"`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  wallsQuery.current = { data: undefined, isFetching: true, dataUpdatedAt: 0, errorUpdatedAt: 0 };
  // The lifecycle list answered for the unfinished wall: not a clone.
  lifecycleQuery.current = {
    data: [{ uuid: 'wall-1', layoutId: 7, archivedAt: null, resetOfWallUuid: null, board: null }],
    isFetching: false,
  };
  resetSourceMock.mockReset();
  // Once-queued answers must not leak from one case into the next.
  resetWallMock.mockReset();
  createWallMock.mockReset();
  identityFields.builder = null;
  fetchVersionsMock.mockReset();
  guard.confirmLeave = null;
  viewer.userId = 'me';
  consentFlips.savingFor.clear();
  editorProps.last = null;
  listEnabled.walls = [];
  listEnabled.lifecycle = [];
  header.leading = null;
  header.trailing = null;
  header.accessory = null;
  hardwareBack.focusEffect = null;
  hardwareBack.handler = null;
  hardwareBack.adjustProps = null;
});
afterEach(cleanup);

describe('resume freshness', () => {
  it('does not decide while a fetch is running over a stale cached empty list', () => {
    setWalls({ data: [], isFetching: true, dataUpdatedAt: BEFORE_MOUNT });
    const { queryByTestId } = mountWizard();

    expect(alertMock).not.toHaveBeenCalled();
    // Still on the resume step: the meta form (a second wall) has not been offered.
    expect(queryByTestId('identity')).toBeNull();
  });

  it('does not decide on a cached list that finished before this screen opened', () => {
    // Not fetching, and `data` is present — but it is the list from before this
    // device created a wall. `isPending` alone would have said "answer now".
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: BEFORE_MOUNT });
    const { queryByTestId } = mountWizard();

    expect(alertMock).not.toHaveBeenCalled();
    expect(queryByTestId('identity')).toBeNull();
  });

  it('offers Pick up and Start over once a fresh list shows an unpublished wall', () => {
    setWalls({ data: [], isFetching: true, dataUpdatedAt: BEFORE_MOUNT });
    const { rerenderWizard } = mountWizard();
    expect(alertMock).not.toHaveBeenCalled();

    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    rerenderWizard();

    expect(alertMock).toHaveBeenCalledTimes(1);
    const [title, body, buttons] = alertMock.mock.calls[0] as [string, string, { text: string }[]];
    expect(title).toBe('sprayWizard.resume.title');
    expect(body).toBe('sprayWizard.resume.body');
    expect(buttons.map((button) => button.text)).toEqual(['sprayWizard.resume.startOver', 'sprayWizard.resume.pickUp']);

    // A later render must not stack a second copy of the question.
    rerenderWizard();
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it('goes straight to a new wall when the fresh list holds nothing to resume', () => {
    setWalls({ data: [], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const { queryByTestId } = mountWizard();

    expect(alertMock).not.toHaveBeenCalled();
    expect(queryByTestId('identity')).not.toBeNull();
    // No wall yet: the training switch is the builder's, sent with the create.
    expect(queryByTestId('builder-consent')).not.toBeNull();
    expect(queryByTestId('server-consent')).toBeNull();
  });

  it("shows the stored training switch, not the builder's, when Back reaches the form of a wall that exists", async () => {
    fetchVersionsMock.mockResolvedValue({ ...UNFINISHED_WALL, versions: [] });
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const { getByText, getByTestId, queryByTestId } = mountWizard();
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());
    expect(getByText('sprayWizard.photo.title')).toBeTruthy();

    expect(header.leading?.kind).toBe('back');
    act(() => header.leading?.onPress());
    expect(queryByTestId('identity')).not.toBeNull();
    expect(getByTestId('server-consent').textContent).toBe('wall-1');
    expect(queryByTestId('builder-consent')).toBeNull();
  });
});

describe('the photo step and Help train hold finding', () => {
  function mountAtNewWallForm() {
    setWalls({ data: [], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    return mountWizard();
  }

  it('says so in a note on a new wall, whose switch is on the step before', () => {
    const { getByText, queryByTestId } = mountAtNewWallForm();
    act(() => header.trailing?.onPress());

    expect(getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(getByText('sprayWizard.photo.trainingNote')).toBeTruthy();
    expect(queryByTestId('server-consent')).toBeNull();
  });

  it('leaves the note out once that switch has been turned off', () => {
    const { getByText, getByTestId, queryByText } = mountAtNewWallForm();
    act(() => getByTestId('builder-consent').click());
    act(() => header.trailing?.onPress());

    expect(getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(queryByText('sprayWizard.photo.trainingNote')).toBeNull();
  });

  it("puts a resumed wall's own switch there, in place of the note", async () => {
    fetchVersionsMock.mockResolvedValue({ ...UNFINISHED_WALL, versions: [] });
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const { getByText, getByTestId, queryByText } = mountWizard();
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());

    expect(getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(getByTestId('server-consent').textContent).toBe('wall-1');
    expect(queryByText('sprayWizard.photo.trainingNote')).toBeNull();
  });

  // On Android a tap anywhere on the switch's row flips it and saves at once.
  // Above the buttons, the row arriving late slid "Choose photo" out from under
  // a thumb and took the tap itself. It holds its place now, and stays down here.
  it('draws that switch last on the step, clear of everything else that can be tapped', async () => {
    fetchVersionsMock.mockResolvedValue({ ...UNFINISHED_WALL, versions: [] });
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const view = mountWizard();
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());

    const consentRow = () => view.getByTestId('server-consent');
    const drawnBeforeTheRow = (element: Element) =>
      (element.compareDocumentPosition(consentRow()) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(drawnBeforeTheRow(view.getByText('sprayWizard.photo.helpLink'))).toBe(true);
    expect(drawnBeforeTheRow(view.getByText('sprayWizard.photo.library'))).toBe(true);

    // With a photo picked, the preview and its crop button come before it too.
    await pickPhotoAndListen(view);
    expect(drawnBeforeTheRow(view.getByText('sprayWizard.photo.pickAnother'))).toBe(true);
    expect(drawnBeforeTheRow(view.getByText('sprayWizard.photo.adjust'))).toBe(true);
    const buttons = [...view.container.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every(drawnBeforeTheRow)).toBe(true);
  });

  it('shows neither to somebody finishing a wall they can edit but do not own', async () => {
    fetchVersionsMock.mockResolvedValue({
      ...UNFINISHED_WALL,
      board: { name: 'Garage wall', ownerId: 'the-owner' },
      versions: [],
    });
    const { getByText, queryByText, queryByTestId } = render(
      <SprayWallWizardScreen returnTo="/(tabs)/climbs" wallUuid="wall-1" />,
    );
    await act(async () => {});

    expect(getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(queryByTestId('server-consent')).toBeNull();
    expect(queryByText('sprayWizard.photo.trainingNote')).toBeNull();

    // Nor on the name step Back leads to.
    act(() => header.leading?.onPress());
    expect(queryByTestId('identity')).not.toBeNull();
    expect(queryByTestId('server-consent')).toBeNull();
    expect(queryByTestId('builder-consent')).toBeNull();
  });

  it('shows neither while it is not yet known who is signed in', async () => {
    viewer.userId = null;
    fetchVersionsMock.mockResolvedValue({ ...UNFINISHED_WALL, versions: [] });
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const { getByText, queryByText, queryByTestId } = mountWizard();
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());

    expect(getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(queryByTestId('server-consent')).toBeNull();
    expect(queryByText('sprayWizard.photo.trainingNote')).toBeNull();
  });
});

describe('native back guard', () => {
  async function resumeIntoEditor() {
    fetchVersionsMock.mockResolvedValue(WALL_WITH_SAVED_DRAFT);
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const view = mountWizard();
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());
    expect(view.queryByTestId('editor')).not.toBeNull();
    alertMock.mockClear();
    return view;
  }

  it('hands the native guard a confirmLeave that is always wired', () => {
    setWalls({ data: [], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    mountWizard();
    expect(guard.confirmLeave).toBeTypeOf('function');
  });

  it('lets a fresh flow with nothing on the server leave without asking', () => {
    setWalls({ data: [], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    mountWizard();
    const onConfirm = vi.fn();

    act(() => guard.confirmLeave?.(onConfirm));

    expect(alertMock).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('asks before leaving a wall that has a draft, and pops only on Leave', async () => {
    await resumeIntoEditor();
    const onConfirm = vi.fn();

    act(() => guard.confirmLeave?.(onConfirm));

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0]).toBe('sprayWizard.leave.title');
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => lastAlertButton('sprayWizard.leave.go').onPress());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not pop when the climber picks Keep going', async () => {
    await resumeIntoEditor();
    const onConfirm = vi.fn();

    act(() => guard.confirmLeave?.(onConfirm));
    const stay = (alertMock.mock.calls[0][2] as { text: string; onPress?: () => void }[]).find(
      (button) => button.text === 'sprayWizard.leave.stay',
    );
    act(() => stay?.onPress?.());

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('asks about unwritten hold changes with the discard dialog instead', async () => {
    await resumeIntoEditor();
    act(() => editorProps.last?.onDirtyChange?.(true));
    const onConfirm = vi.fn();

    act(() => guard.confirmLeave?.(onConfirm));

    expect(confirmDiscardMock).toHaveBeenCalledTimes(1);
    expect(alertMock).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    // The dialog's discard answer is the screen's `confirmed` closure: it must
    // still apply (nothing started publishing) and pop exactly once.
    const confirmed = confirmDiscardMock.mock.calls[0][1] as () => void;
    act(() => confirmed());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('swallows the removal with no dialog while the editor is handing over to publish', async () => {
    await resumeIntoEditor();
    act(() => editorProps.last?.onHandoverChange?.(true));
    const onConfirm = vi.fn();

    act(() => guard.confirmLeave?.(onConfirm));

    expect(alertMock).not.toHaveBeenCalled();
    expect(confirmDiscardMock).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('a reset (`resetOf`)', () => {
  /** The clone `resetSprayWall` hands back: the old wall's settings, nothing else. */
  const CLONE = {
    uuid: 'clone-1',
    layoutId: 8,
    viewerCanEdit: true,
    currentVersion: null,
    resetOfWallUuid: 'old-wall',
    board: { name: 'Garage wall', ownerId: 'me' },
  };
  const CLONE_WITH_PHOTO = {
    ...CLONE,
    versions: [{ id: 'clone-v1', number: 1, status: 'DRAFT', photo: { url: 'https://img/c.jpg' }, addedHoldCount: 4 }],
  };

  async function mountReset() {
    const view = render(<SprayWallWizardScreen returnTo="/(tabs)/climbs" resetOfWallUuid="old-wall" />);
    await act(async () => {});
    return view;
  }

  it('builds the clone and rejoins it at the photo, never asking for a name or angle', async () => {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const { getByText, queryByTestId } = await mountReset();

    expect(resetWallMock).toHaveBeenCalledExactlyOnceWith('old-wall');
    expect(fetchVersionsMock).toHaveBeenCalledWith('clone-1');
    // No list-and-prompt: the reset hands back its own clone.
    expect(alertMock).not.toHaveBeenCalled();
    expect(getByText('sprayWizard.reset.photoTitle')).toBeTruthy();
    expect(queryByTestId('identity')).toBeNull();
  });

  // Back leaves a reset from here and its clone is in no board list, so the
  // photo step is the only place the owner can reach the switch.
  it("puts the clone's training switch on the photo step, in place of the note", async () => {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const { getByText, getByTestId, queryByText } = await mountReset();

    expect(getByText('sprayWizard.reset.photoTitle')).toBeTruthy();
    expect(getByTestId('server-consent').textContent).toBe('clone-1');
    expect(queryByText('sprayWizard.photo.trainingNote')).toBeNull();
  });

  it('leaves the flow from the photo step rather than opening the meta form', async () => {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const { queryByTestId } = await mountReset();

    // Nothing behind a reset's photo step, so the header leads with the X.
    expect(header.leading?.kind).toBe('close');
    act(() => header.leading?.onPress());
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(queryByTestId('identity')).toBeNull();
  });

  it('asks before rejoining a clone that already has a photo, and picks it up at the editor', async () => {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue(CLONE_WITH_PHOTO);
    const { queryByTestId } = await mountReset();

    expect(alertMock).toHaveBeenCalledTimes(1);
    const [title, body] = alertMock.mock.calls[0] as [string, string];
    expect(title).toBe('sprayWizard.reset.resumeTitle');
    expect(body).toBe('sprayWizard.reset.resumeBody');
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());
    expect(queryByTestId('editor')).not.toBeNull();
  });

  // Start over throws away the CLONE and starts a fresh one. The wall being
  // replaced is never named in the discard: it stays live.
  it('starts over by deleting the clone only, then building a fresh one', async () => {
    resetWallMock.mockResolvedValueOnce(CLONE).mockResolvedValueOnce({ ...CLONE, uuid: 'clone-2' });
    fetchVersionsMock
      .mockResolvedValueOnce(CLONE_WITH_PHOTO)
      .mockResolvedValueOnce({ ...CLONE, uuid: 'clone-2', versions: [] });
    const { getByText } = await mountReset();

    await act(async () => lastAlertButton('sprayWizard.resume.startOver').onPress());

    expect(discardDraftMock).toHaveBeenCalledExactlyOnceWith({
      versionId: 'clone-v1',
      wallUuid: 'clone-1',
      layoutId: 8,
    });
    expect(JSON.stringify(discardDraftMock.mock.calls)).not.toContain('old-wall');
    expect(resetWallMock).toHaveBeenCalledTimes(2);
    expect(resetWallMock).toHaveBeenLastCalledWith('old-wall');
    expect(getByText('sprayWizard.reset.photoTitle')).toBeTruthy();
  });

  it('says a failed reset plainly, and Try again asks once more', async () => {
    resetWallMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(CLONE);
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const { getByText } = await mountReset();

    expect(getByText('sprayWizard.reset.startFailed')).toBeTruthy();
    await act(async () => getByText('sprayWizard.resume.retry').click());
    expect(resetWallMock).toHaveBeenCalledTimes(2);
    expect(getByText('sprayWizard.reset.photoTitle')).toBeTruthy();
  });

  it('falls back to a plain sentence for a failure without a code', async () => {
    resetWallMock.mockRejectedValueOnce(new Error('offline'));
    const { getByText } = await mountReset();
    expect(getByText('sprayWizard.reset.startFailed')).toBeTruthy();
    expect(getByText('sprayWizard.back')).toBeTruthy();
  });

  // The reset is counted once per confirm tap, on the board sheet. Reopening
  // a clone with nothing on it yet (one abandoned at the photo) counts nothing.
  it('fires nothing when a draft-less clone is reopened', async () => {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const { getByText } = await mountReset();
    expect(getByText('sprayWizard.reset.photoTitle')).toBeTruthy();
    expect(trackSprayMock).not.toHaveBeenCalled();
  });

  it('does not count reopening an unfinished reset as a new one', async () => {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue(CLONE_WITH_PHOTO);
    await mountReset();
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());
    expect(trackSprayMock).not.toHaveBeenCalled();
  });

  // The second reset call fails: the climber gets the error with Try again and
  // a way back, and the wall being replaced was never named in a discard.
  it('says why when the fresh clone after Start over cannot be made', async () => {
    resetWallMock.mockResolvedValueOnce(CLONE).mockRejectedValueOnce(new Error('offline'));
    fetchVersionsMock.mockResolvedValueOnce(CLONE_WITH_PHOTO);
    const { getByText } = await mountReset();
    await act(async () => lastAlertButton('sprayWizard.resume.startOver').onPress());
    expect(getByText('sprayWizard.reset.startFailed')).toBeTruthy();
    expect(getByText('sprayWizard.resume.retry')).toBeTruthy();
    expect(getByText('sprayWizard.back')).toBeTruthy();
    expect(JSON.stringify(discardDraftMock.mock.calls)).not.toContain('old-wall');
  });

  // Owner only, archived, never published, the archive cap: asking again would
  // get the same answer, so only the way back is offered.
  it.each(['resetOwnerOnly', 'archived', 'resetSourceUnpublished', 'archiveLimitReached'])(
    'offers no Try again for a %s refusal',
    async (refusal) => {
      resetWallMock.mockRejectedValueOnce({ refusal });
      const { getByText, queryByText } = await mountReset();
      expect(getByText(`lifecycle:${refusal}`)).toBeTruthy();
      expect(queryByText('sprayWizard.resume.retry')).toBeNull();
      expect(getByText('sprayWizard.back')).toBeTruthy();
    },
  );

  it('sends one reset for two fast taps on Try again', async () => {
    resetWallMock.mockRejectedValueOnce(new Error('offline'));
    const { getByText } = await mountReset();
    let answer: (clone: typeof CLONE) => void = () => {};
    resetWallMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const retry = getByText('sprayWizard.resume.retry');
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(resetWallMock).toHaveBeenCalledTimes(2);
    await act(async () => answer(CLONE));
    expect(getByText('sprayWizard.reset.photoTitle')).toBeTruthy();
  });

  // The screen went before the server answered: no prompt over whatever the
  // climber moved on to.
  it('raises no prompt when the screen is gone before the reset answers', async () => {
    let answer: (clone: typeof CLONE) => void = () => {};
    resetWallMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    fetchVersionsMock.mockResolvedValue(CLONE_WITH_PHOTO);
    const view = await mountReset();
    view.unmount();
    await act(async () => answer(CLONE));
    expect(alertMock).not.toHaveBeenCalled();
  });
});

describe('a plain "Add a wall" run and reset clones', () => {
  // The full wall payload no longer carries the reset fields; the lifecycle
  // list says which unfinished wall is a reset's clone, and that one is left
  // to its reset.
  it('does not offer a reset clone back as a new wall', () => {
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    lifecycleQuery.current = {
      data: [{ uuid: 'wall-1', layoutId: 7, archivedAt: null, resetOfWallUuid: 'live-wall', board: null }],
      isFetching: false,
    };
    const { queryByTestId } = mountWizard();
    expect(alertMock).not.toHaveBeenCalled();
    expect(queryByTestId('identity')).not.toBeNull();
  });

  it('waits for the lifecycle list before deciding', () => {
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    lifecycleQuery.current = { data: undefined, isFetching: true };
    mountWizard();
    expect(alertMock).not.toHaveBeenCalled();
  });

  // On a backend without the archive fields the list fails, the one-wall read
  // fails too, and the check behaves as it always did.
  it('still offers an unfinished wall when the lifecycle list failed', async () => {
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    lifecycleQuery.current = { data: undefined, isFetching: false };
    resetSourceMock.mockResolvedValueOnce(undefined);
    mountWizard();
    await act(async () => {});
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  // A transient list failure must not offer a reset's clone as a new wall: it
  // would publish through the plain path and never archive the wall it replaces.
  it('asks about the one wall when the list failed, and leaves a clone alone', async () => {
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    lifecycleQuery.current = { data: undefined, isFetching: false };
    resetSourceMock.mockResolvedValueOnce('live-wall');
    const { queryByTestId } = mountWizard();
    await act(async () => {});
    expect(resetSourceMock).toHaveBeenCalledWith('wall-1');
    expect(alertMock).not.toHaveBeenCalled();
    expect(queryByTestId('identity')).not.toBeNull();
  });
});

// A targeted open: an import-progress row or a notification names the wall and
// the draft. It never asks "resume?" and never reads the my-walls list.
describe('a targeted open (`wallUuid` + `versionId`)', () => {
  const DRAFT_ON_WALL = {
    ...UNFINISHED_WALL,
    versions: [{ id: 'v-1', number: 1, status: 'DRAFT', photo: { url: 'https://img/w.jpg' }, addedHoldCount: 2 }],
  };

  async function mountTargeted(versionId = 'v-1') {
    const view = render(<SprayWallWizardScreen returnTo="/(tabs)/climbs" wallUuid="wall-1" versionId={versionId} />);
    await act(async () => {});
    return view;
  }

  it('says the draft is unavailable, with Back and no retry, when it no longer matches', async () => {
    fetchVersionsMock.mockResolvedValue(DRAFT_ON_WALL);
    const { getByText, queryByText } = await mountTargeted('v-gone');

    expect(getByText('sprayImport.unavailable')).toBeTruthy();
    expect(queryByText('sprayWizard.resume.retry')).toBeNull();
    act(() => getByText('sprayWizard.back').click());
    expect(routerMock.replace).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
  });

  it('says the wall is unavailable, with Back and no retry, when the viewer cannot edit it', async () => {
    fetchVersionsMock.mockResolvedValue({ ...DRAFT_ON_WALL, viewerCanEdit: false });
    const { getByText, queryByText } = await mountTargeted();

    expect(getByText('sprayImport.unavailable')).toBeTruthy();
    expect(queryByText('sprayWizard.resume.retry')).toBeNull();
    act(() => getByText('sprayWizard.back').click());
    expect(routerMock.replace).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
  });

  it('offers Try again when the fetch fails, and pressing it fetches again', async () => {
    fetchVersionsMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(DRAFT_ON_WALL);
    const { getByText, queryByText } = await mountTargeted();

    expect(getByText('sprayWizard.resume.checkFailed')).toBeTruthy();
    expect(fetchVersionsMock).toHaveBeenCalledTimes(1);
    await act(async () => getByText('sprayWizard.resume.retry').click());

    expect(fetchVersionsMock).toHaveBeenCalledTimes(2);
    expect(fetchVersionsMock).toHaveBeenLastCalledWith('wall-1');
    expect(queryByText('sprayWizard.resume.checkFailed')).toBeNull();
  });

  it('never asks "resume?" and never turns on the my-walls list', async () => {
    fetchVersionsMock.mockResolvedValue(DRAFT_ON_WALL);
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const { queryByTestId } = await mountTargeted();

    expect(alertMock).not.toHaveBeenCalled();
    expect(fetchVersionsMock).toHaveBeenCalledExactlyOnceWith('wall-1');
    expect(listEnabled.walls.length).toBeGreaterThan(0);
    expect(listEnabled.walls.every((enabled) => enabled === false)).toBe(true);
    expect(listEnabled.lifecycle.every((enabled) => enabled === false)).toBe(true);
    // Went straight to the draft, not to the new-wall form.
    expect(queryByTestId('editor')).not.toBeNull();
    expect(queryByTestId('identity')).toBeNull();
  });
});

describe('the header', () => {
  function mountAtMeta() {
    setWalls({ data: [], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const view = mountWizard();
    expect(view.queryByTestId('identity')).not.toBeNull();
    return view;
  }

  /** The last title the screen gave the header. */
  function lastTitle(): unknown {
    const calls = setOptionsMock.mock.calls.filter(([options]) => 'title' in (options as object));
    return (calls.at(-1)?.[0] as { title?: unknown } | undefined)?.title;
  }

  it('clears the right side while the resume check runs, as nothing can go forward yet', () => {
    mountWizard();
    expect(header.trailing).toBeNull();
    expect(setOptionsMock).toHaveBeenCalledWith({ headerRight: undefined });
  });

  it('leads with the X on the first step and puts Next on the right, off until the wall is named', () => {
    mountAtMeta();
    expect(header.leading?.kind).toBe('close');
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.meta.next', disabled: true, prominent: true });
    expect(header.accessory).toBeNull();
    expect(lastTitle()).toBe('sprayWizard.screenTitle');
  });

  it('sends the X through the history, where the leave guard is waiting', () => {
    mountAtMeta();
    act(() => header.leading?.onPress());
    expect(routerMock.back).toHaveBeenCalledTimes(1);
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
  });

  it('leaves a cold-linked flow for the tab it came from', () => {
    routerMock.canGoBack.mockReturnValueOnce(false);
    mountAtMeta();
    act(() => header.leading?.onPress());
    expect(routerMock.dismissTo).toHaveBeenCalledExactlyOnceWith('/(tabs)/climbs');
  });

  it('steps back with a chevron from the photo step, with no X beside Next and no title', () => {
    const { getByText } = mountAtMeta();
    act(() => header.trailing?.onPress());
    expect(getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(header.leading).toMatchObject({ kind: 'back', disabled: false });
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.photo.next', disabled: true });
    expect(header.accessory).toBeNull();
    expect(lastTitle()).toBe('');

    act(() => header.leading?.onPress());
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(header.leading?.kind).toBe('close');
    expect(header.trailing?.label).toBe('sprayWizard.meta.next');
    expect(lastTitle()).toBe('sprayWizard.screenTitle');
  });

  it('Android Back: falls through on step 1, steps back on a chevron step, cancels the crop, holds while busy', async () => {
    const wallPhoto = await import('../../../lib/spray/wall-photo');
    vi.mocked(wallPhoto.pickWallPhotoFromLibrary).mockResolvedValue({
      outcome: 'picked',
      photo: {
        uri: 'file:///wall.jpg',
        width: 4032,
        height: 3024,
        base: { uri: 'file:///wall.jpg', width: 4032, height: 3024 },
        original: { uri: 'file:///wall.heic', longSide: 4032 },
        edit: null,
      },
    } as unknown as Awaited<ReturnType<typeof wallPhoto.pickWallPhotoFromLibrary>>);
    // A crop render that never finishes: the flow stays busy on the crop step.
    vi.mocked(wallPhoto.renderWallPhotoEdit).mockReturnValue(new Promise(() => {}));

    const { getByText, queryByText, queryByTestId } = mountAtMeta();
    const unsubscribe = hardwareBack.focusEffect?.();
    const pressBack = () => {
      let handled: boolean | undefined;
      act(() => {
        handled = hardwareBack.handler?.();
      });
      return handled;
    };

    // Step 1: falls through to the stack, which the leave guard intercepts.
    expect(pressBack()).toBe(false);

    // A chevron step: steps back inside the flow, never popping the route.
    act(() => header.trailing?.onPress());
    expect(getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(pressBack()).toBe(true);
    expect(queryByTestId('identity')).not.toBeNull();
    expect(routerMock.back).not.toHaveBeenCalled();

    // The crop step: Back is its Cancel.
    act(() => header.trailing?.onPress());
    await act(async () => getByText('sprayWizard.photo.library').click());
    act(() => getByText('sprayWizard.photo.adjust').click());
    expect(queryByTestId('crop')).not.toBeNull();
    expect(pressBack()).toBe(true);
    expect(queryByTestId('crop')).toBeNull();
    expect(getByText('sprayWizard.photo.title')).toBeTruthy();

    // Busy: the crop is rendering. Back is swallowed and nothing moves.
    act(() => getByText('sprayWizard.photo.adjust').click());
    act(() => hardwareBack.adjustProps?.onDone({ quarterTurns: 1, crop: { left: 0, top: 0, right: 1, bottom: 1 } }));
    expect(pressBack()).toBe(true);
    expect(queryByTestId('crop')).not.toBeNull();
    expect(queryByText('sprayWizard.photo.title')).toBeNull();
    expect(routerMock.back).not.toHaveBeenCalled();

    // Unfocused, it stops listening.
    if (typeof unsubscribe === 'function') unsubscribe();
    expect(hardwareBack.handler).toBeNull();
  });
});

// A flip of the training switch saves on the tap, outside the wizard's own
// requests. Moving off the step while it is out would unmount the switch, and
// a refusal would then land as an alert over a later step, with the switch out
// of reach to try again.
describe('while a training switch flip is saving', () => {
  const CLONE = {
    uuid: 'clone-1',
    layoutId: 8,
    viewerCanEdit: true,
    currentVersion: null,
    resetOfWallUuid: 'old-wall',
    board: { name: 'Garage wall', ownerId: 'me' },
  };

  type Wizard = ReturnType<typeof mountWizard>;

  /** The viewer's own unfinished wall, `wall-1`, on the photo step: a chevron leads. */
  async function resumedAtPhoto() {
    fetchVersionsMock.mockResolvedValue({ ...UNFINISHED_WALL, versions: [] });
    setWalls({ data: [UNFINISHED_WALL], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const view = mountWizard();
    await act(async () => lastAlertButton('sprayWizard.resume.pickUp').onPress());
    await pickPhotoAndListen(view);
    return view;
  }

  /** A reset's clone, `clone-1`, on the photo step: the X leads, as Back would leave. */
  async function resetAtPhoto() {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const reset = () => <SprayWallWizardScreen returnTo="/(tabs)/climbs" resetOfWallUuid="old-wall" />;
    const view = render(reset());
    await act(async () => {});
    await pickPhotoAndListen(view);
    return { ...view, rerenderWizard: () => view.rerender(reset()) };
  }

  /** The mutation cache changes and the screen re-renders, as `useIsMutating` makes it. */
  function flipStarts(view: Pick<Wizard, 'rerenderWizard'>, wallUuid: string) {
    consentFlips.savingFor.add(wallUuid);
    view.rerenderWizard();
  }
  function flipSettles(view: Pick<Wizard, 'rerenderWizard'>, wallUuid: string) {
    consentFlips.savingFor.delete(wallUuid);
    view.rerenderWizard();
  }
  function pressHardwareBack(): boolean | undefined {
    let handled: boolean | undefined;
    act(() => {
      handled = hardwareBack.handler?.();
    });
    return handled;
  }

  it('holds Next, the back chevron, Android Back and the crop on the step it was made on', async () => {
    const view = await resumedAtPhoto();
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.photo.next', disabled: false, loading: false });
    expect(header.leading).toMatchObject({ kind: 'back', disabled: false });

    // Next spins, so the dead header has a reason on it.
    flipStarts(view, 'wall-1');
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.photo.next', disabled: true, loading: true });
    expect(header.leading).toMatchObject({ kind: 'back', disabled: true });

    // And none of them moves the flow if it is pressed anyway.
    act(() => header.trailing?.onPress());
    act(() => header.leading?.onPress());
    expect(pressHardwareBack()).toBe(true);
    act(() => view.getByText('sprayWizard.photo.adjust').click());
    expect(view.getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(view.queryByTestId('identity')).toBeNull();
    expect(view.queryByTestId('crop')).toBeNull();
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('asks before a swipe leaves, like any request in flight', async () => {
    const view = await resumedAtPhoto();
    flipStarts(view, 'wall-1');

    const leave = vi.fn();
    act(() => guard.confirmLeave?.(leave));
    expect(leave).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0]?.[0]).toBe('sprayWizard.leave.title');

    // Leaving is still the climber's call; a refusal then reaches them as an alert.
    act(() => lastAlertButton('sprayWizard.leave.go').onPress());
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('lets go of all of it once the flip has settled', async () => {
    const view = await resumedAtPhoto();
    flipStarts(view, 'wall-1');
    expect(header.trailing?.disabled).toBe(true);
    expect(header.leading?.disabled).toBe(true);

    flipSettles(view, 'wall-1');
    expect(header.trailing).toMatchObject({ disabled: false, loading: false });
    expect(header.leading?.disabled).toBe(false);

    // Nothing to ask about any more: this wall has no draft to keep.
    const leave = vi.fn();
    act(() => guard.confirmLeave?.(leave));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(alertMock).not.toHaveBeenCalled();

    // Next goes on to the corners, and Android Back steps back from there.
    act(() => header.trailing?.onPress());
    expect(view.queryByText('sprayWizard.photo.title')).toBeNull();
    expect(pressHardwareBack()).toBe(true);
    expect(view.getByText('sprayWizard.photo.title')).toBeTruthy();
  });

  it('holds Next on the name step as well, where a wall that was created shows its own switch', async () => {
    // A new wall whose upload fails after `createSprayWall` has answered.
    const photoUpload = await import('../../../lib/spray/spray-wall-photo-upload');
    vi.mocked(photoUpload.uploadSprayWallPhoto).mockRejectedValue(new Error('offline'));
    createWallMock.mockResolvedValue({
      uuid: 'wall-9',
      layoutId: 9,
      viewerCanEdit: true,
      board: { name: 'Garage wall', ownerId: 'me' },
    });
    setWalls({ data: [], isFetching: false, dataUpdatedAt: AFTER_MOUNT() });
    const view = mountWizard();
    act(() => identityFields.builder?.setName('Garage wall'));
    act(() => header.trailing?.onPress());
    await pickPhotoAndListen(view);
    act(() => header.trailing?.onPress());
    // Past the corners: the wall is created, then the photo fails to upload.
    await act(async () => header.trailing?.onPress());
    expect(createWallMock).toHaveBeenCalledTimes(1);
    expect(view.getByText('sprayWizard.upload.title')).toBeTruthy();

    // Back, Back: the photo step, then the name step with the server's switch.
    act(() => header.leading?.onPress());
    act(() => header.leading?.onPress());
    expect(view.queryByTestId('identity')).not.toBeNull();
    expect(view.getByTestId('server-consent').textContent).toBe('wall-9');
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.meta.next', disabled: false, loading: false });

    flipStarts(view, 'wall-9');
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.meta.next', disabled: true, loading: true });
    expect(header.leading).toMatchObject({ kind: 'close', disabled: true });
    act(() => header.trailing?.onPress());
    expect(view.queryByTestId('identity')).not.toBeNull();
    expect(view.queryByText('sprayWizard.photo.title')).toBeNull();

    flipSettles(view, 'wall-9');
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.meta.next', disabled: false, loading: false });
    act(() => header.trailing?.onPress());
    expect(view.getByText('sprayWizard.photo.title')).toBeTruthy();
  });

  it('holds the X and Android Back too, where the X is the way back', async () => {
    const view = await resetAtPhoto();
    expect(header.leading).toMatchObject({ kind: 'close', disabled: false });
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.photo.next', disabled: false });
    // Here Android Back falls through to the stack, where the leave guard waits.
    expect(pressHardwareBack()).toBe(false);

    flipStarts(view, 'clone-1');
    expect(header.leading).toMatchObject({ kind: 'close', disabled: true });
    expect(header.trailing).toMatchObject({ label: 'sprayWizard.photo.next', disabled: true });
    act(() => header.leading?.onPress());
    act(() => header.trailing?.onPress());
    expect(pressHardwareBack()).toBe(true);
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(view.getByText('sprayWizard.reset.photoTitle')).toBeTruthy();

    flipSettles(view, 'clone-1');
    expect(header.leading).toMatchObject({ kind: 'close', disabled: false });
    expect(pressHardwareBack()).toBe(false);
    act(() => header.leading?.onPress());
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('is not held by a flip on some other wall', async () => {
    const view = await resumedAtPhoto();
    flipStarts(view, 'wall-2');
    expect(header.trailing?.disabled).toBe(false);
    expect(header.leading?.disabled).toBe(false);
    const leave = vi.fn();
    act(() => guard.confirmLeave?.(leave));
    expect(leave).toHaveBeenCalledTimes(1);

    // The same screen, once it is this wall's switch that is saving.
    flipStarts(view, 'wall-1');
    expect(header.trailing?.disabled).toBe(true);
    expect(header.leading?.disabled).toBe(true);
    act(() => header.trailing?.onPress());
    expect(view.getByText('sprayWizard.photo.title')).toBeTruthy();
  });

  it('refuses a press that queued up behind the flip and landed before the render', async () => {
    const view = await resumedAtPhoto();
    // On the wire, but no render has disabled anything yet.
    consentFlips.savingFor.add('wall-1');
    expect(header.trailing?.disabled).toBe(false);

    act(() => header.trailing?.onPress());
    act(() => header.leading?.onPress());
    expect(pressHardwareBack()).toBe(true);
    act(() => view.getByText('sprayWizard.photo.adjust').click());
    expect(view.getByText('sprayWizard.photo.title')).toBeTruthy();
    expect(view.queryByTestId('identity')).toBeNull();
    expect(view.queryByTestId('crop')).toBeNull();

    const leave = vi.fn();
    act(() => guard.confirmLeave?.(leave));
    expect(leave).not.toHaveBeenCalled();
  });
});
