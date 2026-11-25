// @vitest-environment jsdom
vi.mock('../../../src/lib/onboarding/use-onboarding-link-offer', () => ({ useOnboardingLinkOffer: () => () => false }));
//
// #4166. Creating a board silently did nothing: `handleCreate` looked for an
// already-owned board with the same (type, layout, size, sets) and, on a match,
// skipped the mutation entirely — discarding the filled-in form, activating the
// OLD board and dismissing on the happy path. A climber adding a second
// MoonBoard 2024 at a new gym got switched to their existing one, with no
// message either way.
//
// The contract now: every submit reaches the server, and a duplicate is the
// user's decision, not the client's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { offerHeardSerial } from '../../../src/lib/boards/heard-serial-offer';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };

const createBoardMock = vi.hoisted(() => vi.fn());
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const adoptFoundBoardMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
const markOnboardingSeenMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setBoardRevealTipPendingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const followBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fetchBoardsBySerialNumbersMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const fetchBoardByUuidMock = vi.hoisted(() => vi.fn());
const dismissToMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const setSelectedGymMock = vi.hoisted(() => vi.fn());
const refetchGymMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const refetchPrivacySettingsMock = vi.hoisted(() => vi.fn());
const fetchExistingWallCandidatesMock = vi.hoisted(() => vi.fn());
const openReportMock = vi.hoisted(() => vi.fn());
const dismissSheetMock = vi.hoisted(() => vi.fn());

const state = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  privacyEnabled: undefined as boolean | undefined,
  isPrivate: false,
  settingsLoaded: true,
  isPublic: undefined as boolean | undefined,
  isUnlisted: undefined as boolean | undefined,
  audience: undefined as string | undefined,
  wizard: false,
  gym: undefined as Record<string, unknown> | null | undefined,
  gymError: false,
  selectedGym: null as { uuid: string; name: string } | null,
  gymUuid: undefined as string | undefined,
  directoryReports: true,
  /** The setup Save sends, over the builder's MoonBoard 2024 default. */
  setup: {} as { layoutId?: number; sizeId?: number; setIds?: string },
}));
const popularConfigs = vi.hoisted(() => ({ configs: [{ boardType: 'moonboard', layoutId: 3 }] }));
const presetBoardConfigMock = vi.hoisted(() => vi.fn());
type BuilderOptions =
  | {
      preset?: (boardName: string) => unknown;
      initialBoardName?: string;
      initialSerialNumber?: string;
      privacyEnabled?: boolean;
    }
  | undefined;
const builderCalls = vi.hoisted(() => ({ options: [] as BuilderOptions[] }));

const existingBoard = {
  uuid: 'existing-uuid',
  name: 'Boulder Space - MoonBoard 2024 Standard',
} as unknown as UserBoard;

/** A graphql-request ClientError carrying the server's duplicate-SERIAL rejection. */
function serialExistsError() {
  return {
    response: {
      errors: [
        {
          message: 'That serial is already registered to another board',
          extensions: {
            code: 'BOARD_SERIAL_EXISTS',
            boardUuid: 'existing-uuid',
            slug: 'other-wall',
            name: 'Other wall',
          },
        },
      ],
    },
  };
}

/** A graphql-request ClientError carrying the server's duplicate-CONFIG rejection. */
function duplicateError() {
  return {
    response: {
      errors: [
        {
          message: 'You already have this board at this location',
          extensions: {
            code: 'BOARD_DUPLICATE_CONFIG',
            existingBoardUuid: 'existing-uuid',
            existingBoardName: 'Boulder Space - MoonBoard 2024 Standard',
            existingBoardSlug: 'boulder-space-moonboard',
            existingBoardLocationName: 'Boulder Space',
          },
        },
      ],
    },
  };
}

// Whether Back landed on a wizard step is the hook's own suite
// (use-stepped-back-in-wizard.test.ts); here every report goes out at once.
vi.mock('../../../src/lib/boards/use-stepped-back-in-wizard', () => ({
  useSteppedBackInWizard: () => (report: () => void) => report(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: dismissToMock, replace: replaceMock }),
  useLocalSearchParams: () => state.params,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useCreateBoard: () => ({ mutateAsync: createBoardMock }),
  useFollowBoard: () => ({ mutateAsync: followBoardMock }),
  useProfile: () => ({ data: { displayName: 'Marco' } }),
  usePopularBoardConfigs: () => ({ data: popularConfigs }),
  fetchBoardByUuid: fetchBoardByUuidMock,
  fetchBoardsBySerialNumbers: fetchBoardsBySerialNumbersMock,
  fetchExistingWallCandidates: fetchExistingWallCandidatesMock,
  useGym: (gymUuid: string | null) => ({
    data: gymUuid ? state.gym : undefined,
    // The server answers a gone gym with null: settled, no error.
    isSuccess: gymUuid ? state.gym !== undefined : false,
    isError: gymUuid ? state.gymError : false,
    refetch: refetchGymMock,
  }),
}));

vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useAddBoardWizardEnabled: () => state.wizard,
  useDirectoryReportsEnabled: () => state.directoryReports,
}));
// The report host: openReport is recorded, and its `onClosed` is what lets the
// builder leave after "Use it and fix its setup".
vi.mock('../../../src/components/report-problem/use-report-problem', () => ({
  useReportProblemHost: () => ({ openReport: openReportMock, sheet: null, isOpen: false }),
}));
vi.mock('../../../src/providers/sheet-presentation-provider', () => ({
  dismissManagedSheetAndWait: dismissSheetMock,
}));
vi.mock('../../../src/components/board-discovery/DiscoveryBoardArt', () => ({ DiscoveryBoardArt: () => null }));

// The "already has" sheet (#8151), as buttons: each wall on its shelf (with its
// first detail line, the near-miss line), then Keep setting up mine. A near-miss
// wall gets "as is" and "fix" buttons standing in for the "Is this your wall?" step.
type SheetItem = { key: string; title: string; detailLines?: string[] };
type SheetShelf = { key: string; items: SheetItem[] };
type SheetPick = (item: SheetItem, position: number, shelf: string) => void;
vi.mock('../../../src/components/board-discovery/ExistingWallsSheet', () => ({
  ExistingWallsSheet: ({
    gymName,
    wallCount,
    shelves,
    fixableKeys,
    canKeepMine,
    loading,
    loadFailed,
    onUse,
    onFixSetup,
    onKeepMine,
    onRetry,
  }: {
    gymName: string | null;
    wallCount: number;
    shelves: SheetShelf[];
    fixableKeys: ReadonlySet<string>;
    canKeepMine: boolean;
    loading: boolean;
    loadFailed: boolean;
    onUse: SheetPick;
    onFixSetup: SheetPick;
    onKeepMine: () => void;
    onRetry: () => void;
  }) =>
    createElement('div', { 'data-testid': 'existing-walls' }, [
      createElement('span', { key: 'title' }, `${gymName ?? 'no gym'} has ${wallCount}`),
      loading ? createElement('span', { key: 'loading' }, 'loading walls') : null,
      loadFailed ? createElement('span', { key: 'failed' }, 'walls failed') : null,
      ...shelves.flatMap((shelf) =>
        shelf.items.map((item, index) =>
          createElement(
            'div',
            {
              key: item.key,
              'data-shelf': shelf.key,
              'data-wall': item.key,
              'data-lines': (item.detailLines ?? []).join(' | '),
            },
            [
              createElement('span', { key: 'line' }, item.detailLines?.[0] ?? ''),
              createElement(
                'button',
                { key: 'use', type: 'button', onClick: () => onUse(item, index, shelf.key) },
                `use ${item.title}`,
              ),
              fixableKeys.has(item.key)
                ? createElement(
                    'button',
                    { key: 'fix', type: 'button', onClick: () => onFixSetup(item, index, shelf.key) },
                    `fix ${item.title}`,
                  )
                : null,
            ],
          ),
        ),
      ),
      canKeepMine ? createElement('button', { key: 'keep', type: 'button', onClick: onKeepMine }, 'keep mine') : null,
      loadFailed ? createElement('button', { key: 'retry', type: 'button', onClick: onRetry }, 'retry walls') : null,
    ]),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useSetActiveBoard: () => setActiveBoardMock,
}));

// `useActivateBoard` is the real bind sequence now (issue #4961): the builder no
// longer has its own shorter version, which is why creating a board from
// onboarding used to fire no activation event. Its collaborators are stubbed so
// the sequence itself stays under test.
vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => adoptFoundBoardMock,
  useWillFollowFoundBoard: () => () => false,
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: showToastMock }) }));
vi.mock('../../../src/lib/onboarding/onboarding-storage', () => ({
  markOnboardingSeen: markOnboardingSeenMock,
  setBoardRevealTipPending: setBoardRevealTipPendingMock,
}));
vi.mock('../../../src/lib/error-reporting', () => ({ reportError: vi.fn() }));

vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));

vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => confirmMock }));

vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../src/lib/boards/board-config-preset', () => ({ presetBoardConfig: presetBoardConfigMock }));

// The builder is exercised in its own suite; here it just has to produce a valid
// input so the screen's control flow is what's under test. One object for every
// render, like the real hook's stable callbacks, and the options it was called
// with are kept so the preset wiring can be checked.
const builderState = vi.hoisted(() => ({
  boardName: 'moonboard',
  presetKept: false,
  layoutId: 3,
  sizes: [],
  sizeId: 1,
  setIds: [5, 6, 7, 8, 9, 10],
  rawLayoutName: 'Standard',
  coords: null,
  get selectedGym() {
    return state.selectedGym;
  },
  setSelectedGym: setSelectedGymMock,
  buildCreateInput: () => ({
    boardType: 'moonboard',
    layoutId: state.setup.layoutId ?? 3,
    sizeId: state.setup.sizeId ?? 1,
    setIds: state.setup.setIds ?? '5,6,7,8,9,10',
    name: 'Klimmuur MoonBoard',
    angle: 25,
    locationName: 'Klimmuur',
    audience: state.audience,
    isPublic: state.isPublic,
    isUnlisted: state.isUnlisted,
    gymUuid: state.gymUuid,
  }),
}));

vi.mock('../../../src/components/board-discovery/use-board-builder', () => ({
  useBoardBuilder: (_seed: unknown, options?: BuilderOptions) => {
    builderCalls.options.push(options);
    return builderState;
  },
}));

vi.mock('../../../src/components/board-discovery/board-builder-labels', () => ({
  formatDefaultBoardName: () => 'Default name',
  formatGymBoardName: ({ gymName }: { gymName: string }) => `${gymName} MoonBoard`,
  boardTypeLabel: (boardName: string) => boardName,
}));

// Stand-ins that expose just enough DOM to drive the flow.
vi.mock('../../../src/components/board-discovery/BoardForm', () => ({
  BoardForm: ({
    onSubmit,
    errorMessage,
    defaultName,
    submitBlocked,
    errorAction,
    configError,
    setupStyle,
    gymLocked,
    gymLockedHint,
    stepLabel,
  }: {
    onSubmit: () => void;
    errorMessage?: string | null;
    defaultName: string;
    submitBlocked?: boolean;
    errorAction?: { label: string; onPress: () => void };
    configError?: { field: string; invalidSetIds: readonly number[] } | null;
    setupStyle?: string;
    gymLocked?: boolean;
    gymLockedHint?: string;
    stepLabel?: string | null;
  }) =>
    createElement(
      'div',
      {
        'data-testid': 'board-form',
        'data-default-name': defaultName,
        'data-submit-blocked': String(!!submitBlocked),
        'data-config-error': configError ? `${configError.field}:${configError.invalidSetIds.join(',')}` : '',
        'data-setup-style': setupStyle ?? 'chips',
        'data-gym-locked': String(!!gymLocked),
        'data-gym-locked-hint': gymLockedHint ?? '',
        'data-step-label': stepLabel ?? '',
      },
      [
        // Drawn enabled whatever `submitBlocked` says, so a test can prove the
        // screen itself refuses the tap too.
        createElement('button', { key: 'submit', type: 'button', onClick: onSubmit }, 'submit'),
        errorMessage ? createElement('span', { key: 'error', 'data-testid': 'error' }, errorMessage) : null,
        errorAction
          ? createElement('button', { key: 'action', type: 'button', onClick: errorAction.onPress }, errorAction.label)
          : null,
      ],
    ),
}));

vi.mock('../../../src/components/board-discovery/BoardDuplicatePromptSheet', () => ({
  BoardDuplicatePromptSheet: ({
    duplicate,
    onUseExisting,
    onAddAnother,
  }: {
    duplicate: { boardName: string };
    onUseExisting: () => void;
    onAddAnother: () => void;
  }) =>
    createElement('div', { 'data-testid': 'duplicate-prompt' }, [
      createElement('span', { key: 'name' }, duplicate.boardName),
      createElement('button', { key: 'use', type: 'button', onClick: onUseExisting }, 'use existing'),
      createElement('button', { key: 'add', type: 'button', onClick: onAddAnother }, 'add another'),
    ]),
}));

vi.mock('../../../src/components/board-discovery/SerialReuseConfirmSheet', () => ({
  SerialReuseConfirmSheet: ({
    visible,
    onCreateAnyway,
    onUseExisting,
  }: {
    visible: boolean;
    onCreateAnyway: () => void;
    onUseExisting: () => void;
  }) =>
    visible
      ? createElement('div', { 'data-testid': 'serial-prompt' }, [
          createElement('button', { key: 'anyway', type: 'button', onClick: onCreateAnyway }, 'create anyway'),
          createElement('button', { key: 'existing', type: 'button', onClick: onUseExisting }, 'use that wall'),
        ])
      : null,
}));

// The real catalogue, so the near-miss lines and the setup check are the
// shipped rules; only the board-type parse passes anything through.
vi.mock('@boardsesh/board-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/board-config')>()),
  toBoardName: (value: string | undefined) => value ?? null,
}));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

const { default: CreateBoard } = await import('../create');

beforeEach(() => {
  vi.clearAllMocks();
  state.params = {};
  state.privacyEnabled = undefined;
  state.isPrivate = false;
  state.settingsLoaded = true;
  state.isPublic = undefined;
  state.isUnlisted = undefined;
  refetchPrivacySettingsMock.mockResolvedValue({ data: { isPrivate: false, enabled: state.privacyEnabled } });
  state.audience = undefined;
  state.wizard = false;
  state.gym = undefined;
  state.gymError = false;
  state.selectedGym = null;
  state.gymUuid = undefined;
  state.directoryReports = true;
  state.setup = {};
  builderState.boardName = 'moonboard';
  builderState.layoutId = 3;
  builderState.sizeId = 1;
  builderState.setIds = [5, 6, 7, 8, 9, 10];
  fetchExistingWallCandidatesMock.mockResolvedValue({ candidates: [], truncated: false });
  dismissSheetMock.mockResolvedValue({ status: 'dismissed' });
  confirmMock.mockResolvedValue(true);
  builderCalls.options = [];
  builderState.presetKept = false;
  createBoardMock.mockResolvedValue({ uuid: 'new-uuid', name: 'Klimmuur MoonBoard' } as unknown as UserBoard);
  fetchBoardByUuidMock.mockResolvedValue(existingBoard);
  fetchBoardsBySerialNumbersMock.mockResolvedValue([]);
  followBoardMock.mockResolvedValue(undefined);
});

describe('CreateBoard', () => {
  it.each([{ isPublic: false }, { isUnlisted: true }])(
    'does not warn for legacy restricted boards: %o',
    async (visibility) => {
      state.isPrivate = true;
      Object.assign(state, visibility);
      render(createElement(CreateBoard));
      fireEvent.click(screen.getByText('submit'));
      await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
      expect(confirmMock).not.toHaveBeenCalled();
    },
  );

  it('loads a private account before permitting default-public creation', async () => {
    state.settingsLoaded = false;
    refetchPrivacySettingsMock.mockResolvedValueOnce({ data: { isPrivate: true, enabled: true } });
    confirmMock.mockResolvedValueOnce(false);
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(refetchPrivacySettingsMock).toHaveBeenCalledTimes(1);
    expect(createBoardMock).not.toHaveBeenCalled();
  });

  it('shows a settings-load error without creating and unlocks another attempt', async () => {
    state.settingsLoaded = false;
    refetchPrivacySettingsMock.mockRejectedValueOnce(new Error('network down'));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(createBoardMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
  });

  it('waits for a private account to confirm the default public board', async () => {
    state.isPrivate = true;
    let answerConfirm: (answer: boolean) => void = () => {};
    confirmMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answerConfirm = resolve;
        }),
    );
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    fireEvent.click(screen.getByText('submit'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'privacy.publishResourceMessage' }));
    expect(createBoardMock).not.toHaveBeenCalled();
    answerConfirm(true);
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
  });

  it('keeps a cancelled public board unsaved and permits another attempt', async () => {
    state.isPrivate = true;
    confirmMock.mockResolvedValueOnce(false);
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(createBoardMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledTimes(2);
  });

  it.each(['followers', 'invite_only', 'unlisted'])(
    'does not warn a private account creating a %s board',
    async (audience) => {
      state.isPrivate = true;
      state.audience = audience;
      render(createElement(CreateBoard));
      fireEvent.click(screen.getByText('submit'));
      await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
      expect(confirmMock).not.toHaveBeenCalled();
    },
  );

  it('enables the builder privacy defaults when server settings arrive', () => {
    const rendered = render(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.privacyEnabled).toBeUndefined();
    state.privacyEnabled = true;
    rendered.rerender(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.privacyEnabled).toBe(true);
  });

  it('always calls the server, even when the config matches an owned board', async () => {
    // The #4166 repro: previously an owned config match short-circuited here and
    // the mutation was never reached.
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
    // The user's typed values reach the server rather than being discarded.
    expect(createBoardMock.mock.calls[0][0]).toMatchObject({
      name: 'Klimmuur MoonBoard',
      angle: 25,
      locationName: 'Klimmuur',
    });
    expect(createBoardMock.mock.calls[0][0].allowDuplicateConfig).toBeUndefined();
  });

  it('activates the new board and dismisses on success', async () => {
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() =>
      expect(setActiveBoardMock).toHaveBeenCalledWith({ uuid: 'new-uuid', name: 'Klimmuur MoonBoard' }),
    );
    expect(dismissToMock).toHaveBeenCalled();
  });

  it('prompts instead of navigating when the server reports a duplicate', async () => {
    createBoardMock.mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    expect(screen.getByText('Boulder Space - MoonBoard 2024 Standard')).toBeTruthy();
    // Critically: no silent switch and no dismissal.
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    expect(dismissToMock).not.toHaveBeenCalled();
  });

  it('retries with allowDuplicateConfig when the user says it is a different wall', async () => {
    createBoardMock.mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('add another'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0].allowDuplicateConfig).toBe(true);
    // Saying "this is a different wall" answers the CONFIG guard and nothing
    // else. The serial guard is a separate question with a separate prompt.
    expect(createBoardMock.mock.calls[1][0].allowDuplicateSerial).toBeUndefined();
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
  });

  it('chains the two guards, carrying both confirmations onto the retry', async () => {
    // The serial guard and the config guard ask different questions about the
    // same create, and the server can raise them one after the other. Answering
    // the second must not silently drop the answer to the first — otherwise the
    // retry re-trips the serial guard and the climber loops forever.
    createBoardMock.mockRejectedValueOnce(serialExistsError()).mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('serial-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('create anyway'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0].allowDuplicateSerial).toBe(true);
    expect(createBoardMock.mock.calls[1][0].allowDuplicateConfig).toBeUndefined();

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('add another'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(3));
    expect(createBoardMock.mock.calls[2][0]).toMatchObject({
      allowDuplicateSerial: true,
      allowDuplicateConfig: true,
    });
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
  });

  it('switches to the existing board when the user picks it', async () => {
    createBoardMock.mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('use existing'));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledWith(existingBoard));
    expect(fetchBoardByUuidMock).toHaveBeenCalledWith('existing-uuid');
    expect(createBoardMock).toHaveBeenCalledTimes(1);
  });

  it('names the account cap instead of echoing the server message', async () => {
    // 'board_limit' has to stay out of the 'exception' bucket: retrying will
    // never clear it, and the way out (delete a board) belongs in our own copy.
    createBoardMock.mockRejectedValueOnce({
      response: {
        errors: [
          {
            message: 'You have reached the maximum of 50 boards for one account',
            extensions: { code: 'BOARD_LIMIT_REACHED', maxBoards: 50 },
          },
        ],
      },
    });
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.getByTestId('error').textContent).toBe('mobile.create.limitReached');
    expect(trackMock).toHaveBeenCalledWith(
      'Board Create Failed',
      expect.objectContaining({ error_reason: 'board_limit' }),
    );
    expect(dismissToMock).not.toHaveBeenCalled();
  });

  it('shows a non-duplicate failure inline rather than as an invisible toast', async () => {
    // This screen is a `presentation: 'modal'` route, and the toast overlay
    // renders behind those — a toast here would never be seen.
    createBoardMock.mockRejectedValueOnce(new Error('boom'));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(dismissToMock).not.toHaveBeenCalled();
  });
});

// #5654. "My own board" opens the builder with a setup chosen; and a builder
// that closes without a board says so, because most newcomers who opened it
// left without one.
describe('CreateBoard from "My own board"', () => {
  it('asks the builder for a preset, from the popular setups the picker loaded', () => {
    state.params = { preset: '1', source: 'onboarding' };
    render(createElement(CreateBoard));

    const preset = builderCalls.options.at(-1)?.preset;
    expect(preset).toBeTypeOf('function');
    preset?.('kilter');
    expect(presetBoardConfigMock).toHaveBeenCalledWith('kilter', popularConfigs.configs);
  });

  it('opens the builder empty without the param', () => {
    render(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.preset).toBeUndefined();
  });

  // The Bluetooth quickstart heard a board it couldn't name and the climber
  // said it's their own: open on that type, not on Kilter.
  it('opens on the board type the quickstart heard', () => {
    state.params = { preset: '1', presetBoardType: 'moonboard', source: 'onboarding' };
    render(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.initialBoardName).toBe('moonboard');
  });

  // The one unsaved box of that type the In range slot heard: its serial is
  // filled in, but only the one the picker just offered for that type.
  it('opens with the serial the In range slot heard', () => {
    offerHeardSerial({ serial: '751737', boardType: 'kilter' });
    state.params = { preset: '1', presetBoardType: 'kilter', serial: ' 751737 ' };
    render(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.initialSerialNumber).toBe('751737');
  });

  it.each<{ name: string; params: Record<string, string> }>([
    { name: 'without the param', params: { preset: '1', presetBoardType: 'kilter' } },
    { name: 'outside a preset open', params: { presetBoardType: 'kilter', serial: '751737' } },
    { name: 'from a link with no board type', params: { preset: '1', serial: '751737' } },
    {
      name: 'when the board type disagrees with the offer',
      params: { preset: '1', presetBoardType: 'tension', serial: '751737' },
    },
    {
      name: 'for a serial the picker never offered',
      params: { preset: '1', presetBoardType: 'kilter', serial: '800001' },
    },
  ])('opens with the serial empty $name', ({ params }) => {
    offerHeardSerial({ serial: '751737', boardType: 'kilter' });
    state.params = params;
    render(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.initialSerialNumber).toBeUndefined();
  });

  it('opens with the serial empty once the offer has run out', () => {
    offerHeardSerial({ serial: '751737', boardType: 'kilter' }, Date.now() - 11 * 60 * 1000);
    state.params = { preset: '1', presetBoardType: 'kilter', serial: '751737' };
    render(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.initialSerialNumber).toBeUndefined();
  });

  // `toBoardName` (mocked here) is what drops a type this build doesn't know.
  it('ignores the board type without a preset open', () => {
    state.params = { presetBoardType: 'moonboard' };
    render(createElement(CreateBoard));
    expect(builderCalls.options.at(-1)?.initialBoardName).toBeUndefined();
  });
});

// Whether the preset raised completion, and whether preset boards were saved
// with a setup nobody checked.
describe('Board Created from "My own board"', () => {
  function eventProps(name: string) {
    return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props);
  }

  it('says the builder was preset and the setup was saved untouched', async () => {
    state.params = { preset: '1', source: 'no_board' };
    builderState.presetKept = true;
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(eventProps('Board Created')).toHaveLength(1));
    expect(eventProps('Board Created')[0]).toMatchObject({ preset: true, presetKept: true });
  });

  it('says neither for a builder opened without a preset', async () => {
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(eventProps('Board Created')).toHaveLength(1));
    expect(eventProps('Board Created')[0]).toMatchObject({ preset: false, presetKept: false });
  });

  it('carries both onto a switch to the board the climber already has', async () => {
    state.params = { preset: '1', source: 'onboarding' };
    builderState.presetKept = true;
    createBoardMock.mockRejectedValueOnce(duplicateError());
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('use existing'));

    await waitFor(() => expect(eventProps('Board Create Reused Existing')).toHaveLength(1));
    expect(eventProps('Board Create Reused Existing')[0]).toEqual({
      boardType: 'moonboard',
      source: 'scratch',
      preset: true,
      presetKept: true,
    });
  });
});

describe('Board Builder Abandoned', () => {
  function abandonedEvents() {
    return trackMock.mock.calls.filter(([name]) => name === 'Board Builder Abandoned');
  }

  it('fires when the builder closes without a board', () => {
    state.params = { preset: '1', source: 'no_board' };
    const { unmount } = render(createElement(CreateBoard));
    unmount();

    expect(abandonedEvents()).toHaveLength(1);
    expect(abandonedEvents()[0][1]).toEqual({
      boardType: 'moonboard',
      hadLayout: true,
      hadSize: true,
      source: 'scratch',
      preset: true,
      openedFrom: 'no_board',
      submitAttempted: false,
      secondsOpen: 0,
      kind: null,
      step: 'form',
      wizardPath: null,
      wizardEntry: null,
    });
  });

  it('says a Save was tried when the server refused it', async () => {
    createBoardMock.mockRejectedValueOnce(new Error('boom'));
    const { unmount } = render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    unmount();

    expect(abandonedEvents()[0][1]).toMatchObject({ submitAttempted: true, openedFrom: 'board_picker', preset: false });
  });

  it('stays quiet once a board is created', async () => {
    const { unmount } = render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
    unmount();

    expect(abandonedEvents()).toEqual([]);
  });

  it('stays quiet when the climber switches to the board they already have', async () => {
    createBoardMock.mockRejectedValueOnce(duplicateError());
    const { unmount } = render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('use existing'));
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
    unmount();

    expect(abandonedEvents()).toEqual([]);
  });
});

vi.mock('../../../src/lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => ({
    data: state.settingsLoaded ? { enabled: state.privacyEnabled, isPrivate: state.isPrivate } : undefined,
    refetch: refetchPrivacySettingsMock,
  }),
}));

/** A graphql-request ClientError carrying the server's existing-wall refusal (#8151). */
function existingWallsError(candidates: { boardUuid: string; matchKind: string | null }[]) {
  return {
    response: {
      errors: [
        {
          message: 'This gym already has this wall',
          extensions: { code: 'BOARD_EXISTING_WALLS', candidates },
        },
      ],
    },
  };
}

const gymWall = {
  uuid: 'gym-wall',
  name: 'Boulder Space MoonBoard',
  boardType: 'moonboard',
  layoutId: 3,
  sizeId: 1,
  setIds: '5,6,7,8,9,10',
  angle: 40,
  ownerId: 'someone-else',
  isFollowedByMe: false,
  gymName: 'Boulder Space',
} as unknown as UserBoard;

describe('CreateBoard existing-wall recheck (#8151)', () => {
  function namedWall(uuid: string) {
    return { ...gymWall, uuid, name: `Wall ${uuid}` } as UserBoard;
  }

  it('always asks the server to check for existing walls, flag or not', async () => {
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
    expect(createBoardMock.mock.calls[0][0].existingWallCheck).toBe('REJECT_IF_FOUND');
    expect(createBoardMock.mock.calls[0][0].acknowledgedWallUuids).toBeUndefined();
  });

  // The wall list has no setup to compare against: acknowledging its walls
  // there would let an exact copy, or the one missing its feet, through.
  it('sends REJECT_IF_FOUND on the first Save from the wall list, acknowledging nothing', async () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1', boardType: 'moonboard', acknowledged: 'wall-a,wall-b' };
    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3 };
    render(createElement(CreateBoard));
    await waitFor(() => expect(setSelectedGymMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
    expect(createBoardMock.mock.calls[0][0].existingWallCheck).toBe('REJECT_IF_FOUND');
    expect(createBoardMock.mock.calls[0][0].acknowledgedWallUuids).toBeUndefined();
    const created = trackMock.mock.calls.find(([name]) => name === 'Board Created');
    expect(created?.[1]).toMatchObject({ kind: 'gym', candidateCount: 0, confirmedDistinct: false });
  });

  it('shows the walls the refusal named and keeps the form', async () => {
    state.selectedGym = { uuid: 'gym-1', name: 'Boulder Space' };
    createBoardMock.mockRejectedValueOnce(existingWallsError([{ boardUuid: 'gym-wall', matchKind: 'EXACT' }]));
    fetchBoardByUuidMock.mockResolvedValue(gymWall);
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByText('use Boulder Space MoonBoard')).toBeTruthy());
    expect(screen.getByText('Boulder Space has 1')).toBeTruthy();
    expect(fetchBoardByUuidMock).toHaveBeenCalledWith('gym-wall');
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    expect(screen.getByText('submit')).toBeTruthy();
    const shown = trackMock.mock.calls.find(([name]) => name === 'Board Wall Candidates Shown');
    expect(shown?.[1]).toMatchObject({ exactCount: 1, lookup: 'ok', trigger: 'pre_submit' });
  });

  it('resends as CONFIRMED_SEPARATE with the walls shown, and gates a second refusal the same way', async () => {
    createBoardMock
      .mockRejectedValueOnce(existingWallsError([{ boardUuid: 'wall-a', matchKind: 'EXACT' }]))
      .mockRejectedValueOnce(existingWallsError([{ boardUuid: 'wall-b', matchKind: 'SETS_DIFFER' }]));
    fetchBoardByUuidMock.mockImplementation(async (uuid: string) => namedWall(uuid));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByText('use Wall wall-a')).toBeTruthy());
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0]).toMatchObject({
      existingWallCheck: 'CONFIRMED_SEPARATE',
      acknowledgedWallUuids: ['wall-a'],
    });

    // A second refusal brings the sheet back, form intact; the newest wall leads.
    await waitFor(() => expect(screen.getByText('use Wall wall-b')).toBeTruthy());
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(3));
    expect(createBoardMock.mock.calls[2][0].acknowledgedWallUuids).toEqual(['wall-b', 'wall-a']);
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
  });

  it('keeps the newest walls when the 40-wall cap bites, so it can never loop on the same ones', async () => {
    const first = Array.from({ length: 45 }, (_, index) => ({ boardUuid: `old-${index}`, matchKind: 'EXACT' }));
    const second = Array.from({ length: 5 }, (_, index) => ({ boardUuid: `new-${index}`, matchKind: 'EXACT' }));
    createBoardMock.mockRejectedValueOnce(existingWallsError(first)).mockRejectedValueOnce(existingWallsError(second));
    fetchBoardByUuidMock.mockImplementation(async (uuid: string) => namedWall(uuid));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByText('use Wall old-0')).toBeTruthy());
    // Only the 40 it can acknowledge are looked up; the rest say so.
    expect(fetchBoardByUuidMock).toHaveBeenCalledTimes(40);
    expect(screen.getByText('walls failed')).toBeTruthy();
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0].acknowledgedWallUuids).toHaveLength(40);

    await waitFor(() => expect(screen.getByText('use Wall new-0')).toBeTruthy());
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(3));
    const third = createBoardMock.mock.calls[2][0].acknowledgedWallUuids as string[];
    expect(third).toHaveLength(40);
    expect(third.slice(0, 5)).toEqual(['new-0', 'new-1', 'new-2', 'new-3', 'new-4']);
  });

  it('keeps an earlier override on the resend', async () => {
    createBoardMock
      .mockRejectedValueOnce(duplicateError())
      .mockRejectedValueOnce(existingWallsError([{ boardUuid: 'gym-wall', matchKind: 'EXACT' }]));
    fetchBoardByUuidMock.mockResolvedValue(gymWall);
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByTestId('duplicate-prompt')).toBeTruthy());
    fireEvent.click(screen.getByText('add another'));
    await waitFor(() => expect(screen.getByText('keep mine')).toBeTruthy());
    fireEvent.click(screen.getByText('keep mine'));

    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(3));
    expect(createBoardMock.mock.calls[2][0]).toMatchObject({
      allowDuplicateConfig: true,
      existingWallCheck: 'CONFIRMED_SEPARATE',
      acknowledgedWallUuids: ['gym-wall'],
    });
  });

  it('follows the wall and binds it on Use this board, creating nothing', async () => {
    createBoardMock.mockRejectedValueOnce(existingWallsError([{ boardUuid: 'gym-wall', matchKind: 'EXACT' }]));
    fetchBoardByUuidMock.mockResolvedValue(gymWall);
    const { unmount } = render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByText('use Boulder Space MoonBoard')).toBeTruthy());
    fireEvent.click(screen.getByText('use Boulder Space MoonBoard'));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledWith(gymWall));
    expect(followBoardMock).toHaveBeenCalledWith(gymWall);
    expect(createBoardMock).toHaveBeenCalledTimes(1);
    const used = trackMock.mock.calls.find(([name]) => name === 'Board Wall Candidate Used');
    expect(used?.[1]).toMatchObject({ match: 'exact', position: 0, alreadyFollowed: false, trigger: 'pre_submit' });
    unmount();
    expect(trackMock.mock.calls.filter(([name]) => name === 'Board Builder Abandoned')).toEqual([]);
  });

  it('still counts a quit when binding the wall failed', async () => {
    createBoardMock.mockRejectedValueOnce(existingWallsError([{ boardUuid: 'gym-wall', matchKind: 'EXACT' }]));
    fetchBoardByUuidMock.mockResolvedValue(gymWall);
    setActiveBoardMock.mockRejectedValueOnce(new Error('storage full'));
    const { unmount } = render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByText('use Boulder Space MoonBoard')).toBeTruthy());
    fireEvent.click(screen.getByText('use Boulder Space MoonBoard'));
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('mobile.findWall.useError'));
    unmount();
    expect(trackMock.mock.calls.filter(([name]) => name === 'Board Builder Abandoned')).toHaveLength(1);
  });

  it('acknowledges only the walls it could show when some lookups fail, and says so', async () => {
    createBoardMock.mockRejectedValueOnce(
      existingWallsError([
        { boardUuid: 'gym-wall', matchKind: 'EXACT' },
        { boardUuid: 'lost-wall', matchKind: 'EXACT' },
      ]),
    );
    fetchBoardByUuidMock.mockImplementation(async (uuid: string) => {
      if (uuid === 'lost-wall') throw new Error('offline');
      return gymWall;
    });
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByText('walls failed')).toBeTruthy());
    expect(screen.getByText('use Boulder Space MoonBoard')).toBeTruthy();
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0].acknowledgedWallUuids).toEqual(['gym-wall']);
  });

  it('offers only Try again when no wall could be loaded, never a blind Keep mine', async () => {
    createBoardMock.mockRejectedValueOnce(existingWallsError([{ boardUuid: 'gym-wall', matchKind: 'EXACT' }]));
    fetchBoardByUuidMock.mockRejectedValueOnce(new Error('offline'));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByText('walls failed')).toBeTruthy());
    expect(screen.queryByText('keep mine')).toBeNull();
    const shown = trackMock.mock.calls.find(([name]) => name === 'Board Wall Candidates Shown');
    expect(shown?.[1]).toMatchObject({ lookup: 'failed' });

    fetchBoardByUuidMock.mockResolvedValue(gymWall);
    fireEvent.click(screen.getByText('retry walls'));
    await waitFor(() => expect(screen.getByText('use Boulder Space MoonBoard')).toBeTruthy());
    expect(createBoardMock).toHaveBeenCalledTimes(1);
  });

  it('treats a refusal that names no walls as a plain failure, not a resend', async () => {
    createBoardMock.mockRejectedValueOnce(existingWallsError([]));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByTestId('error')).toBeTruthy());
    expect(screen.queryByTestId('existing-walls')).toBeNull();
    expect(createBoardMock).toHaveBeenCalledTimes(1);
  });
});

describe('CreateBoard near-miss walls (#8151)', () => {
  // The climber's Masters 2019, with its Screw-on Feet (set 20).
  const masters2019 = { layoutId: 5, sizeId: 1, setIds: '17,18,19,20,21,22,23' };
  const noFeet = {
    ...gymWall,
    uuid: 'no-feet',
    name: 'Wall no-feet',
    layoutId: 5,
    setIds: '17,18,19,21,22,23',
  } as unknown as UserBoard;
  const seeded2016 = {
    ...gymWall,
    uuid: 'seeded-2016',
    name: 'Wall seeded-2016',
    layoutId: 2,
    setIds: '2,3,4',
  } as unknown as UserBoard;

  function refuseWithNearMiss() {
    state.setup = masters2019;
    state.selectedGym = { uuid: 'gym-1', name: 'Boulder Space' };
    state.gymUuid = 'gym-1';
    createBoardMock.mockRejectedValueOnce(existingWallsError([{ boardUuid: 'no-feet', matchKind: 'SETS_DIFFER' }]));
    fetchBoardByUuidMock.mockResolvedValue(noFeet);
    fetchExistingWallCandidatesMock.mockResolvedValue({
      candidates: [
        { board: noFeet, matchKind: 'SETS_DIFFER' },
        { board: seeded2016, matchKind: 'LAYOUT_OR_SIZE_DIFFERS' },
      ],
      truncated: false,
    });
  }
  const shelvesShown = () =>
    [...screen.getByTestId('existing-walls').querySelectorAll('[data-wall]')].map((wall) => [
      wall.getAttribute('data-shelf'),
      wall.getAttribute('data-wall'),
      wall.querySelector('span')?.textContent,
    ]);

  it('adds the walls on another layout as a lower shelf, each saying what differs', async () => {
    refuseWithNearMiss();
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByText('use Wall seeded-2016')).toBeTruthy());
    expect(fetchExistingWallCandidatesMock).toHaveBeenCalledWith({
      boardType: 'moonboard',
      gymUuid: 'gym-1',
      ...masters2019,
    });
    expect(shelvesShown()).toEqual([
      ['set_up_differently', 'no-feet', 'mobile.create.existingWalls.missingSets {"sets":"Screw-on Feet"}'],
      [
        'setup_mismatch',
        'seeded-2016',
        'mobile.create.existingWalls.layoutDiffers {"wall":"2016","yours":"Masters 2019"}',
      ],
    ]);
    // Only the wall the refusal named is acknowledged: the 2016 record never blocks.
    fireEvent.click(screen.getByText('keep mine'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(2));
    expect(createBoardMock.mock.calls[1][0].acknowledgedWallUuids).toEqual(['no-feet']);
  });

  it('counts every wall it shows in the title, and reports the lower shelf once it settles', async () => {
    refuseWithNearMiss();
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByText('use Wall seeded-2016')).toBeTruthy());
    expect(screen.getByText('Boulder Space has 2')).toBeTruthy();
    const shown = trackMock.mock.calls.filter(([name]) => name === 'Board Wall Candidates Shown');
    expect(shown).toHaveLength(1);
    expect(shown[0][1]).toMatchObject({ nearMissCount: 1, mismatchCount: 1, mismatchLookup: 'ok' });
  });

  it('names the nearby listing on a wall found there, not this gym', async () => {
    refuseWithNearMiss();
    const annexWall = { ...seeded2016, uuid: 'annex-2016', name: 'Wall annex-2016' } as UserBoard;
    fetchExistingWallCandidatesMock.mockResolvedValue({
      candidates: [
        {
          board: noFeet,
          matchKind: 'SETS_DIFFER',
          source: 'SELECTED_GYM',
          gymName: 'Boulder Space',
          gymDistanceMeters: null,
        },
        {
          board: annexWall,
          matchKind: 'LAYOUT_OR_SIZE_DIFFERS',
          source: 'NEARBY_LISTING',
          gymName: 'Boulder Space Annex',
          gymDistanceMeters: 82.4,
        },
      ],
      truncated: false,
    });
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByText('use Wall annex-2016')).toBeTruthy());
    const row = screen.getByTestId('existing-walls').querySelector('[data-wall="annex-2016"]');
    expect(row?.getAttribute('data-lines')).toContain(
      'mobile.findWall.nearbyGym {"gym":"Boulder Space Annex","distance":82}',
    );
    const own = screen.getByTestId('existing-walls').querySelector('[data-wall="no-feet"]');
    expect(own?.getAttribute('data-lines')).not.toContain('mobile.findWall.nearbyGym');
  });

  it('keeps the named walls when the lower shelf cannot load', async () => {
    refuseWithNearMiss();
    fetchExistingWallCandidatesMock.mockRejectedValue(new Error('rate limited'));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(fetchExistingWallCandidatesMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('use Wall no-feet')).toBeTruthy());
    expect(screen.queryByText('use Wall seeded-2016')).toBeNull();
    expect(screen.queryByText('walls failed')).toBeNull();
    await waitFor(() =>
      expect(trackMock.mock.calls.find(([name]) => name === 'Board Wall Candidates Shown')?.[1]).toMatchObject({
        mismatchCount: 0,
        mismatchLookup: 'failed',
      }),
    );
  });

  it('uses a near miss as it is, saying so', async () => {
    refuseWithNearMiss();
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByText('use Wall seeded-2016')).toBeTruthy());
    fireEvent.click(screen.getByText('use Wall seeded-2016'));

    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledWith(seeded2016));
    expect(followBoardMock).toHaveBeenCalledWith(seeded2016);
    expect(openReportMock).not.toHaveBeenCalled();
    const used = trackMock.mock.calls.find(([name]) => name === 'Board Wall Candidate Used');
    expect(used?.[1]).toMatchObject({ match: 'near_miss', position: 0, fixSetupStarted: false, trigger: 'pre_submit' });
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
  });

  it('uses it and opens Set up wrong on the climber setup, leaving only once the report closes', async () => {
    refuseWithNearMiss();
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByText('fix Wall no-feet')).toBeTruthy());
    fireEvent.click(screen.getByText('fix Wall no-feet'));

    await waitFor(() => expect(openReportMock).toHaveBeenCalledTimes(1));
    // Followed and bound first; the walls sheet went and settled before the report.
    expect(followBoardMock).toHaveBeenCalledWith(noFeet);
    expect(dismissSheetMock).toHaveBeenCalledTimes(1);
    expect(setActiveBoardMock).toHaveBeenCalledWith(noFeet);
    const [target, options] = openReportMock.mock.calls[0];
    expect(target).toEqual({ kind: 'board', board: noFeet });
    expect(options).toMatchObject({
      initialReason: 'wrong_setup',
      initialSetup: masters2019,
      climbNowOffered: false,
    });
    expect(createBoardMock).toHaveBeenCalledTimes(1);
    const used = trackMock.mock.calls.find(([name]) => name === 'Board Wall Candidate Used');
    expect(used?.[1]).toMatchObject({ match: 'near_miss', fixSetupStarted: true });
    expect(dismissToMock).not.toHaveBeenCalled();

    // Sent or not, the climber's board is bound: closing the report leaves.
    options.onClosed();
    await waitFor(() => expect(dismissToMock).toHaveBeenCalled());
  });

  it('offers no fix when Report a problem is off', async () => {
    refuseWithNearMiss();
    state.directoryReports = false;
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByText('use Wall no-feet')).toBeTruthy());
    expect(screen.queryByText('fix Wall no-feet')).toBeNull();
  });
});

describe('CreateBoard catalogue errors (#8151)', () => {
  function unknownConfigError(extensions: Record<string, unknown>) {
    return {
      response: {
        errors: [
          { message: 'Unknown board configuration', extensions: { code: 'UNKNOWN_BOARD_CONFIG', ...extensions } },
        ],
      },
    };
  }
  const configError = () => screen.getByTestId('board-form').getAttribute('data-config-error');

  it('marks a layout the bundled catalogue lacks before Save goes out', () => {
    state.setup = { layoutId: 999 };
    builderState.layoutId = 999;
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    expect(createBoardMock).not.toHaveBeenCalled();
    expect(configError()).toBe('layoutId:');
    expect(screen.queryByTestId('error')).toBeNull();
    const failed = trackMock.mock.calls.find(([name]) => name === 'Board Create Failed');
    expect(failed?.[1]).toMatchObject({ error_reason: 'unknown_config' });
  });

  it("puts the server's refused sets on the holds row, keeps the form, and clears once the sets change", async () => {
    createBoardMock.mockRejectedValueOnce(unknownConfigError({ field: 'setIds', invalidSetIds: [10] }));
    const { rerender } = render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(configError()).toBe('setIds:10'));
    expect(screen.queryByTestId('error')).toBeNull();
    expect(screen.getByText('submit')).toBeTruthy();

    builderState.setIds = [5, 6, 7, 8, 9];
    rerender(createElement(CreateBoard));
    expect(configError()).toBe('');
  });

  it('says so in its own words when an older server names no field', async () => {
    createBoardMock.mockRejectedValueOnce(unknownConfigError({}));
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('mobile.create.configError.noField'));
    expect(configError()).toBe('');
  });
});

describe('CreateBoard from the gym-first flow (#8151)', () => {
  it('prefills the gym from the wall list, coordinates and all, once', async () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1', boardType: 'moonboard' };
    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3 };
    const { rerender } = render(createElement(CreateBoard));
    rerender(createElement(CreateBoard));
    await waitFor(() => expect(setSelectedGymMock).toHaveBeenCalledTimes(1));
    expect(setSelectedGymMock).toHaveBeenCalledWith({
      uuid: 'gym-1',
      name: 'Boulder Space',
      latitude: 52.1,
      longitude: 4.3,
    });
  });

  it('holds Save until the prefilled gym lands, so the board never saves without it', async () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1', boardType: 'moonboard' };
    const { container, rerender } = render(createElement(CreateBoard));
    expect(container.querySelector('[data-submit-blocked]')?.getAttribute('data-submit-blocked')).toBe('true');
    fireEvent.click(screen.getByText('submit'));
    expect(createBoardMock).not.toHaveBeenCalled();

    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3 };
    rerender(createElement(CreateBoard));
    await waitFor(() =>
      expect(container.querySelector('[data-submit-blocked]')?.getAttribute('data-submit-blocked')).toBe('false'),
    );
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
  });

  it('says a gym that is gone is gone, and lets the climber go on without it', async () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1', boardType: 'moonboard' };
    state.gym = null;
    const { container } = render(createElement(CreateBoard));
    expect(screen.getByTestId('error').textContent).toBe('mobile.create.gymUnavailable');
    expect(container.querySelector('[data-submit-blocked]')?.getAttribute('data-submit-blocked')).toBe('true');
    fireEvent.click(screen.getByText('submit'));
    expect(createBoardMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('mobile.create.chooseAnotherGym'));
    expect(container.querySelector('[data-submit-blocked]')?.getAttribute('data-submit-blocked')).toBe('false');
    expect(screen.queryByTestId('error')).toBeNull();
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
    expect(setSelectedGymMock).not.toHaveBeenCalled();
  });

  it('lets a gym picked in the form unblock Save, and never overwrites it with a late prefill', async () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1', boardType: 'moonboard' };
    const { container, rerender } = render(createElement(CreateBoard));
    expect(container.querySelector('[data-submit-blocked]')?.getAttribute('data-submit-blocked')).toBe('true');

    state.selectedGym = { uuid: 'gym-2', name: 'Crag Hall' };
    rerender(createElement(CreateBoard));
    expect(container.querySelector('[data-submit-blocked]')?.getAttribute('data-submit-blocked')).toBe('false');

    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3 };
    rerender(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(createBoardMock).toHaveBeenCalledTimes(1));
    expect(setSelectedGymMock).not.toHaveBeenCalled();
  });

  it('says the gym failed to load, with Try again, instead of saving without it', () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1' };
    state.gymError = true;
    render(createElement(CreateBoard));
    expect(screen.getByTestId('error').textContent).toBe('mobile.findWall.gymFailed');
    fireEvent.click(screen.getByText('submit'));
    expect(createBoardMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('mobile.findWall.retry'));
    expect(refetchGymMock).toHaveBeenCalled();
  });

  it('opens on the board type the wall list chose', () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1', boardType: 'kilter' };
    render(createElement(CreateBoard));
    expect(builderCalls.options[0]?.initialBoardName).toBe('kilter');
  });

  it('names a gym board for the gym', () => {
    state.params = { kind: 'gym', gymUuid: 'gym-1' };
    state.selectedGym = { uuid: 'gym-1', name: 'Boulder Space' };
    const { container } = render(createElement(CreateBoard));
    expect(container.querySelector('[data-default-name]')?.getAttribute('data-default-name')).toBe(
      'Boulder Space MoonBoard',
    );
  });

  it('starts the add-a-board wizard for a bare open with the flag on', () => {
    state.wizard = true;
    state.params = { returnTo: '/(tabs)/discover', source: 'no_board' };
    const { unmount } = render(createElement(CreateBoard));
    expect(replaceMock).toHaveBeenCalledWith({
      pathname: '/boards/add',
      params: { returnTo: '/(tabs)/discover', source: 'no_board', entry: 'link' },
    });
    expect(screen.queryByText('submit')).toBeNull();
    unmount();
    // The hand-off is not an abandonment: the choice screen reports for itself.
    expect(trackMock.mock.calls.filter(([name]) => name === 'Board Builder Abandoned')).toEqual([]);
  });

  it.each([
    { name: 'a preset open', params: { preset: '1' } },
    { name: 'a kind already said', params: { kind: 'home', preset: '1' } },
    { name: 'a gym already chosen', params: { kind: 'gym', gymUuid: 'gym-1' } },
  ])('opens the builder for $name', ({ params }) => {
    state.wizard = true;
    state.params = params;
    render(createElement(CreateBoard));
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByText('submit')).toBeTruthy();
  });

  it('opens the builder for a bare open with the flag off', () => {
    render(createElement(CreateBoard));
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('says which flow a builder left from on Board Builder Abandoned', () => {
    state.params = { kind: 'home', preset: '1' };
    const { unmount } = render(createElement(CreateBoard));
    unmount();
    const abandoned = trackMock.mock.calls.find(([name]) => name === 'Board Builder Abandoned');
    expect(abandoned?.[1]).toMatchObject({ kind: 'home', step: 'form' });
  });
});

describe("CreateBoard as the add-a-board wizard's Set up", () => {
  function form(container: HTMLElement) {
    const element = container.querySelector('[data-testid="board-form"]');
    if (!element) throw new Error('no form');
    return element;
  }

  it('keeps the chip builder with the flag off, and the rows with it on', () => {
    state.params = { kind: 'home', preset: '1', presetBoardType: 'kilter' };
    const off = render(createElement(CreateBoard));
    expect(form(off.container).getAttribute('data-setup-style')).toBe('chips');
    off.unmount();

    state.wizard = true;
    const on = render(createElement(CreateBoard));
    expect(form(on.container).getAttribute('data-setup-style')).toBe('rows');
  });

  it('counts itself as the last step of the path it came through', () => {
    state.wizard = true;
    state.params = { kind: 'home', path: 'home', entry: 'picker', trail: 'where,board', preset: '1' };
    const { container } = render(createElement(CreateBoard));
    expect(form(container).getAttribute('data-step-label')).toBe(
      'mobile.addWizard.stepCounter {"current":3,"total":3}',
    );
    expect(trackMock).toHaveBeenCalledWith('Add Board Wizard Step Viewed', {
      step: 'setup',
      path: 'home',
      entry: 'picker',
    });
  });

  it("shows no counter when it is the flow's only screen (the In range slot's own board)", () => {
    state.wizard = true;
    state.params = { kind: 'home', path: 'home', entry: 'in_range', preset: '1', presetBoardType: 'kilter' };
    const { container } = render(createElement(CreateBoard));
    expect(form(container).getAttribute('data-step-label')).toBe('');
  });

  it('locks the gym the wizard picked once it lands, never with the flag off', async () => {
    state.wizard = true;
    state.params = { kind: 'gym', path: 'gym', entry: 'gym_page', gymUuid: 'gym-1', boardType: 'moonboard' };
    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3 };
    const { container, rerender, unmount } = render(createElement(CreateBoard));
    rerender(createElement(CreateBoard));
    await waitFor(() => expect(form(container).getAttribute('data-gym-locked')).toBe('true'));
    unmount();

    state.wizard = false;
    const off = render(createElement(CreateBoard));
    off.rerender(createElement(CreateBoard));
    await waitFor(() => expect(setSelectedGymMock).toHaveBeenCalled());
    expect(form(off.container).getAttribute('data-gym-locked')).toBe('false');
  });

  it("says a gym page's lock comes from that page, with no step to go back to", async () => {
    state.wizard = true;
    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3 };
    state.params = { kind: 'gym', path: 'gym', entry: 'gym_page', trail: 'gym_boards', gymUuid: 'gym-1' };
    const page = render(createElement(CreateBoard));
    page.rerender(createElement(CreateBoard));
    await waitFor(() => expect(form(page.container).getAttribute('data-gym-locked')).toBe('true'));
    expect(form(page.container).getAttribute('data-gym-locked-hint')).toBe('mobile.addWizard.gymLockedHintGymPage');
    page.unmount();

    // From the wizard's own gym step, the default hint (go back a step).
    state.params = { ...state.params, entry: 'picker', trail: 'where,gym,gym_boards' };
    const wizard = render(createElement(CreateBoard));
    wizard.rerender(createElement(CreateBoard));
    await waitFor(() => expect(form(wizard.container).getAttribute('data-gym-locked')).toBe('true'));
    expect(form(wizard.container).getAttribute('data-gym-locked-hint')).toBe('');
    wizard.unmount();

    // A gym the climber just added on Add your gym: theirs, and Back leads to Which gym?.
    state.params = { ...state.params, entry: 'picker', trail: 'where,gym,new_gym' };
    const added = render(createElement(CreateBoard));
    added.rerender(createElement(CreateBoard));
    await waitFor(() => expect(form(added.container).getAttribute('data-gym-locked')).toBe('true'));
    expect(form(added.container).getAttribute('data-gym-locked-hint')).toBe('mobile.addWizard.gymLockedHintNewGym');
  });

  // A gym's wall is shared: the wizard opens it on its type only, and nothing
  // below is guessed for it, so Board Created says no preset.
  it('opens a gym board on its type without a preset, and a home board with one', async () => {
    state.wizard = true;
    state.gym = { uuid: 'gym-1', name: 'Boulder Space', latitude: 52.1, longitude: 4.3 };
    state.params = { kind: 'gym', path: 'gym', entry: 'picker', boardType: 'moonboard', gymUuid: 'gym-1' };
    const { rerender } = render(createElement(CreateBoard));
    rerender(createElement(CreateBoard));
    await waitFor(() => expect(setSelectedGymMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Created',
        expect.objectContaining({ preset: false, wizardPath: 'gym', kind: 'gym' }),
      ),
    );
  });

  it("carries the wizard's path and entry on Board Created, so completion splits by entry", async () => {
    state.wizard = true;
    state.params = { kind: 'home', path: 'home', entry: 'first_run', trail: 'where,board', preset: '1' };
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Created',
        expect.objectContaining({ kind: 'home', wizardPath: 'home', wizardEntry: 'first_run' }),
      ),
    );
  });

  it('sends null path and entry when the wizard did not open it', async () => {
    state.wizard = true;
    state.params = { kind: 'home', preset: '1' };
    render(createElement(CreateBoard));
    fireEvent.click(screen.getByText('submit'));
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Created',
        expect.objectContaining({ wizardPath: null, wizardEntry: null }),
      ),
    );
    expect(trackMock.mock.calls.filter(([name]) => name === 'Add Board Wizard Step Viewed')).toEqual([]);
  });
});
