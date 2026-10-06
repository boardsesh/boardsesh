// @vitest-environment jsdom
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
//    header back and Android Back ask the same question as the footer.
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

vi.mock('react-native', () => ({
  AccessibilityInfo: { isReduceMotionEnabled: vi.fn(async () => false), addEventListener: () => ({ remove() {} }) },
  Alert: { alert: alertMock },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  Platform: { OS: 'ios' },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { hairlineWidth: 1, absoluteFillObject: {}, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() }),
  useNavigation: () => ({ getParent: () => undefined }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en-US', language: 'en-US' } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemBlue: '#007AFF', systemRed: '#FF3B30' } }));
vi.mock('../../../providers/theme-provider', () => ({
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
vi.mock('../../../lib/spray/spray-telemetry', () => ({ trackSprayEvent: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
// The photo step's shooting-guide link (#6141). The real module loads
// expo-web-browser, whose native event emitter does not exist under node.
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: () => undefined,
  extractGraphqlCode: () => undefined,
}));
vi.mock('../../../lib/boards/use-activate-board', () => ({ useActivateBoard: () => vi.fn() }));
vi.mock('../../../lib/spray/activate-published-spray-wall', () => ({ activatePublishedSprayWall: vi.fn() }));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({ invalidateSprayWallRenderData: vi.fn() }));
vi.mock('../../../lib/spray/use-spray-wall-draft', () => ({ prefetchSprayWallDraft: vi.fn() }));
vi.mock('../../../lib/spray/spray-wall-photo-upload', () => ({ uploadSprayWallPhoto: vi.fn() }));
vi.mock('../../../lib/spray/camera-capability', () => ({ canPhotographWall: () => false }));
vi.mock('../../../lib/spray/wall-photo', () => ({
  pickWallPhotoFromLibrary: vi.fn(),
  pickWallPhotoFromCamera: vi.fn(),
  rescalePoint: (point: [number, number]) => point,
}));
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  fetchSprayWallVersions: fetchVersionsMock,
  useMySprayWalls: () => ({ ...wallsQuery.current, refetch: vi.fn() }),
  useCreateSprayWall: () => ({ mutateAsync: vi.fn() }),
  useCreateSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  usePublishSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  useUpdateSprayWallVisibility: () => ({ mutateAsync: vi.fn() }),
  useDiscardSprayWallDraft: () => ({ mutateAsync: vi.fn(async () => true) }),
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
// Online throughout: the upload-notice wording has its own suite (#5960).
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivityField: () => null }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({ getConnectivitySnapshot: () => ({ reason: null }) }));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../SprayCornerFooter', () => ({ SprayCornerFooter: () => null }));
vi.mock('../SprayCornerStep', () => ({ SprayCornerStep: () => null }));
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
  board: { name: 'Garage wall' },
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
  guard.confirmLeave = null;
  editorProps.last = null;
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
