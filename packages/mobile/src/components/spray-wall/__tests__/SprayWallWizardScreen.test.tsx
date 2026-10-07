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
const resetWallMock = vi.hoisted(() => vi.fn());
const discardDraftMock = vi.hoisted(() => vi.fn(async () => true));
const routerMock = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() }));
/** The fail-soft lifecycle list: which walls are a reset's clone. */
const lifecycleQuery = vi.hoisted(() => ({
  current: { data: undefined as unknown, isFetching: false },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { isReduceMotionEnabled: vi.fn(async () => false), addEventListener: () => ({ remove() {} }) },
  Alert: { alert: alertMock },
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
vi.mock('../../../lib/boards/use-activate-board', () => ({ useActivateBoard: () => vi.fn() }));
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
  useMySprayWalls: () => ({ ...wallsQuery.current, refetch: vi.fn() }),
  useCreateSprayWall: () => ({ mutateAsync: vi.fn() }),
  useCreateSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  usePublishSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  useUpdateSprayWallVisibility: () => ({ mutateAsync: vi.fn() }),
  useDiscardSprayWallDraft: () => ({ mutateAsync: discardDraftMock }),
  useResetSprayWall: () => ({ mutateAsync: resetWallMock }),
  useMySprayWallLifecycle: () => lifecycleQuery.current,
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
vi.mock('../SprayPhotoAdjustStep', () => ({ SprayPhotoAdjustStep: () => null }));
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
  // The lifecycle list answered for the unfinished wall: not a clone.
  lifecycleQuery.current = {
    data: [{ uuid: 'wall-1', layoutId: 7, archivedAt: null, resetOfWallUuid: null, board: null }],
    isFetching: false,
  };
  resetSourceMock.mockReset();
  // Once-queued answers must not leak from one case into the next.
  resetWallMock.mockReset();
  fetchVersionsMock.mockReset();
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

describe('a reset (`resetOf`)', () => {
  /** The clone `resetSprayWall` hands back: the old wall's settings, nothing else. */
  const CLONE = {
    uuid: 'clone-1',
    layoutId: 8,
    viewerCanEdit: true,
    currentVersion: null,
    resetOfWallUuid: 'old-wall',
    board: { name: 'Garage wall' },
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

  it('leaves the flow from the photo step rather than opening the meta form', async () => {
    resetWallMock.mockResolvedValue(CLONE);
    fetchVersionsMock.mockResolvedValue({ ...CLONE, versions: [] });
    const { getByText, queryByTestId } = await mountReset();

    act(() => getByText('sprayWizard.back').click());
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
