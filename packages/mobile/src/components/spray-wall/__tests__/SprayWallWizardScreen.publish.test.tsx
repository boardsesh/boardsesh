// @vitest-environment jsdom
//
// The add-a-wall wizard's last two steps, mounted: publish, then the bind that
// leaves the flow.
//
// TestFlight found the wizard parked forever on "Setting your wall up…" with
// the wall published and never bound. `post-publish-bind.test.ts` pins the
// chain on its own; this pins what the SCREEN does with it:
//
//  - a bind that hangs turns into the publish step's error and Try again, and
//    the retry binds again without publishing a second time;
//  - a dismiss that does not land is followed once, by itself, by a different
//    road out (closing the Boards modal through the root stack);
//  - and `done` offers its own way out once the bind has taken too long.
//
// The run is resumed onto a saved draft, which is the shortest road to the
// publish step: the resume prompt, the editor's commit and the look's confirm
// are each one call into a stubbed child.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type AlertButton = { text: string; onPress?: () => void };

const mocks = vi.hoisted(() => ({
  alert: vi.fn<(title: string, body?: string, buttons?: AlertButton[]) => void>(),
  dismissTo: vi.fn<(href: string) => void>(),
  back: vi.fn<() => void>(),
  replace: vi.fn<(href: string) => void>(),
  rootCanGoBack: vi.fn<() => boolean>(),
  rootGoBack: vi.fn<() => void>(),
  hasParent: { current: true },
  publishVersion: vi.fn<(versionId: string) => Promise<unknown>>(),
  updateVisibility: vi.fn<(input: unknown) => Promise<unknown>>(),
  activate:
    vi.fn<
      (
        queryClient: unknown,
        wallUuid: string,
        activateBoard: (board: UserBoard) => Promise<void>,
        options?: { onStage?: (stage: 'fetch_board' | 'bind') => void; isLive?: () => boolean },
      ) => Promise<void>
    >(),
  finish: vi.fn<(board: UserBoard) => Promise<void>>(),
  activateBoardOptions: { current: null as null | { navigate?: () => void } },
  invalidateRenderData: vi.fn<() => Promise<void>>(),
  fetchVersions: vi.fn<(wallUuid: string) => Promise<unknown>>(),
  reportError: vi.fn<(error: unknown, context?: unknown) => void>(),
  editorProps: { current: null as null | { onCommitted: (summary: unknown) => void } },
  lookProps: { current: null as null | { onConfirmed: () => void } },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Alert: { alert: mocks.alert },
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  Platform: { OS: 'ios' },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { hairlineWidth: 1, create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: mocks.dismissTo, back: mocks.back, replace: mocks.replace }),
  useNavigation: () => ({
    getParent: () =>
      mocks.hasParent.current ? { canGoBack: mocks.rootCanGoBack, goBack: mocks.rootGoBack } : undefined,
  }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivityField: () => null }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({ getConnectivitySnapshot: () => ({ reason: null }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en-US', language: 'en-US' } }),
}));
vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: { BoardCreated: 'Board Created' },
  sprayHoldsReviewed: (properties: Record<string, unknown>) => ({ name: 'r', properties }),
  sprayWallPhotoPicked: (source: string) => ({ name: 'p', properties: { source } }),
  sprayWallUploadFinished: (properties: Record<string, unknown>) => ({ name: 'u', properties }),
  sprayWallBindStalled: (properties: Record<string, unknown>) => ({ name: 'Spray Wall Bind Stalled', properties }),
}));
vi.mock('../../../lib/spray/spray-telemetry', () => ({ trackSprayEvent: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: mocks.reportError, addErrorBreadcrumb: vi.fn() }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: () => undefined,
  extractGraphqlCode: () => undefined,
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemBlue: '#007AFF', systemRed: '#FF3B30' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888', tertiaryLabel: '#999', separator: '#222', tertiaryBackground: '#333' },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('i') }));
vi.mock('../../board-discovery/GymPickerSheet', () => ({ GymPickerSheet: () => null }));
vi.mock('../../board-discovery/BoardMetaFields', () => ({
  BoardIdentityFields: () => null,
  BoardVisibilityFields: () => null,
  SectionLabel: () => null,
}));
// One object for the whole file: the wizard's callbacks list the builder as a
// dependency, and a fresh one per render would rebuild every one of them.
const builder = vi.hoisted(() => ({
  pendingVisibility: () => null,
  buildCreateInput: () => null,
  canCreate: false,
  angle: 40,
  setAngle: () => {},
  locationName: '',
  coords: null,
  selectedGym: null,
  setSelectedGym: () => {},
}));
vi.mock('../../board-discovery/use-spray-wall-builder', () => ({
  SPRAY_ANGLE_OPTIONS: [40],
  useSprayWallBuilder: () => builder,
}));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../SprayCornerFooter', () => ({ SprayCornerFooter: () => null }));
vi.mock('../SprayCornerStep', () => ({ SprayCornerStep: () => null }));
vi.mock('../SprayDetectionStep', () => ({ SprayDetectionStep: () => null }));
vi.mock('../../outline-editor/SprayHoldEditorScreen', () => ({
  confirmDiscardSprayEdits: vi.fn(),
  SprayHoldEditorScreen: (props: { onCommitted: (summary: unknown) => void }) => {
    mocks.editorProps.current = props;
    return createElement('div', { 'data-testid': 'editor' });
  },
}));
vi.mock('../SprayWallLookStep', () => ({
  SprayWallLookStep: (props: { onConfirmed: () => void }) => {
    mocks.lookProps.current = props;
    return createElement('div', { 'data-testid': 'look' });
  },
}));
// Native removal prevention is covered by use-spray-wizard-leave-guard.test.tsx.
vi.mock('../use-spray-wizard-leave-guard', () => ({ useSprayWizardLeaveGuard: vi.fn() }));
vi.mock('../../../lib/spray/camera-capability', () => ({ canPhotographWall: () => false }));
vi.mock('../../../lib/spray/wall-photo', () => ({
  pickWallPhotoFromCamera: vi.fn(),
  pickWallPhotoFromLibrary: vi.fn(),
  rescalePoint: (point: unknown) => point,
}));
vi.mock('../../../lib/spray/spray-wall-photo-upload', () => ({ uploadSprayWallPhoto: vi.fn() }));
vi.mock('../../../lib/spray/spray-wall-loader', () => ({ invalidateSprayWallRenderData: mocks.invalidateRenderData }));
vi.mock('../../../lib/spray/use-spray-wall-draft', () => ({ prefetchSprayWallDraft: vi.fn() }));
vi.mock('../../../lib/spray/activate-published-spray-wall', () => ({ activatePublishedSprayWall: mocks.activate }));
vi.mock('../../../lib/boards/use-activate-board', () => ({
  useActivateBoard: (options: { navigate?: () => void }) => {
    mocks.activateBoardOptions.current = options;
    return mocks.finish;
  },
}));

const WALL = {
  uuid: 'wall-1',
  layoutId: 7,
  viewerCanEdit: true,
  currentVersion: null,
  board: { uuid: 'wall-1', name: 'Garage wall', boardType: 'spray' },
};
const mySprayWalls = {
  // Settled after any mount, so the resume check reads it straight away.
  isFetching: false,
  dataUpdatedAt: Number.MAX_SAFE_INTEGER,
  errorUpdatedAt: 0,
  refetch: vi.fn(),
  data: [WALL],
};
vi.mock('../../../lib/spray/use-create-spray-wall', () => ({
  fetchSprayWallVersions: mocks.fetchVersions,
  useCreateSprayWall: () => ({ mutateAsync: vi.fn() }),
  useCreateSprayWallVersion: () => ({ mutateAsync: vi.fn() }),
  useDiscardSprayWallDraft: () => ({ mutateAsync: vi.fn() }),
  useMySprayWalls: () => mySprayWalls,
  usePublishSprayWallVersion: () => ({ mutateAsync: mocks.publishVersion }),
  useUpdateSprayWallVisibility: () => ({ mutateAsync: mocks.updateVisibility }),
}));

const { SprayWallWizardScreen } = await import('../SprayWallWizardScreen');
const { BIND_STAGE_DEADLINE_MS, DONE_EXIT_OFFER_MS, NAVIGATION_SETTLE_MS } =
  await import('../../../lib/spray/post-publish-bind');

const PUBLISHED_BOARD = { uuid: 'wall-1', name: 'Garage wall', boardType: 'spray' } as unknown as UserBoard;

/** Let pending promise callbacks and the effects they schedule run. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Mount, pick the draft back up, commit its holds and confirm its look: publish starts by itself. */
async function reachPublish() {
  const view = render(createElement(SprayWallWizardScreen, { returnTo: '/(tabs)/climbs' }));
  await flush();
  const buttons = mocks.alert.mock.calls[0]?.[2] ?? [];
  const pickUp = buttons.find((button) => button.text === 'sprayWizard.resume.pickUp');
  act(() => pickUp?.onPress?.());
  await flush();
  expect(screen.getByTestId('editor')).toBeTruthy();
  act(() => mocks.editorProps.current?.onCommitted({ written: 0, removed: 0, holdCount: 5 }));
  expect(screen.getByTestId('look')).toBeTruthy();
  act(() => mocks.lookProps.current?.onConfirmed());
  await flush();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.fetchVersions.mockResolvedValue({
    board: WALL.board,
    layoutId: WALL.layoutId,
    versions: [{ id: 'version-1', number: 1, status: 'DRAFT', photo: { url: 'https://photo' }, addedHoldCount: 5 }],
  });
  mocks.publishVersion.mockResolvedValue({ id: 'version-1' });
  mocks.invalidateRenderData.mockResolvedValue(undefined);
  mocks.finish.mockResolvedValue(undefined);
  mocks.rootCanGoBack.mockReturnValue(true);
  mocks.hasParent.current = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SprayWallWizardScreen — publish and bind', () => {
  it('leaves once the bind lands, through its own navigation rather than the hook', async () => {
    mocks.activate.mockImplementation(async (_queryClient, _wallUuid, activateBoard) => {
      await activateBoard(PUBLISHED_BOARD);
    });
    const view = await reachPublish();

    expect(mocks.publishVersion).toHaveBeenCalledWith('version-1');
    expect(mocks.finish).toHaveBeenCalledWith(PUBLISHED_BOARD);
    expect(mocks.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
    // The hook is handed a navigation that does nothing, so it cannot leave twice.
    mocks.activateBoardOptions.current?.navigate?.();
    expect(mocks.dismissTo).toHaveBeenCalledTimes(1);
    expect(mocks.rootGoBack).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    view.unmount();
  });

  it('turns a bind that never finishes into an error with Try again, and the retry only re-binds', async () => {
    mocks.activate.mockImplementationOnce(() => new Promise<void>(() => {}));
    await reachPublish();
    expect(screen.getByText('sprayWizard.done.body')).toBeTruthy();

    await flush(BIND_STAGE_DEADLINE_MS);
    expect(screen.getByText('sprayWizard.publish.stalled')).toBeTruthy();
    expect(mocks.dismissTo).not.toHaveBeenCalled();

    mocks.activate.mockImplementationOnce(async (_queryClient, _wallUuid, activateBoard) => {
      await activateBoard(PUBLISHED_BOARD);
    });
    fireEvent.click(screen.getByText('sprayWizard.publish.retry'));
    await flush();

    // Published once: the latch held across the failed bind.
    expect(mocks.publishVersion).toHaveBeenCalledTimes(1);
    expect(mocks.activate).toHaveBeenCalledTimes(2);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTo).toHaveBeenCalledTimes(1);
    // The re-bind runs on `done`, where the leave guard lets the dismiss through.
    expect(screen.getByText('sprayWizard.done.body')).toBeTruthy();
  });

  it('closes the Boards modal by another road when the first dismiss leaves the wizard on screen', async () => {
    mocks.activate.mockImplementation(async (_queryClient, _wallUuid, activateBoard) => {
      await activateBoard(PUBLISHED_BOARD);
    });
    await reachPublish();
    expect(mocks.dismissTo).toHaveBeenCalledTimes(1);

    await flush(NAVIGATION_SETTLE_MS);
    // Not the same `dismissTo` again: it would fail the way the first one did.
    expect(mocks.dismissTo).toHaveBeenCalledTimes(1);
    expect(mocks.rootGoBack).toHaveBeenCalledTimes(1);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { kind: 'spray_bind_navigated_noop' } }),
    );

    // Once only: anything further is the climber's to ask for.
    await flush(NAVIGATION_SETTLE_MS * 4);
    expect(mocks.rootGoBack).toHaveBeenCalledTimes(1);
  });

  it('replaces the modal with the tab only when nothing is underneath it', async () => {
    mocks.rootCanGoBack.mockReturnValue(false);
    mocks.activate.mockImplementation(async (_queryClient, _wallUuid, activateBoard) => {
      await activateBoard(PUBLISHED_BOARD);
    });
    await reachPublish();

    await flush(NAVIGATION_SETTLE_MS);
    expect(mocks.rootGoBack).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  it('offers a way out of done once the bind has taken too long', async () => {
    mocks.activate.mockImplementation(() => new Promise<void>(() => {}));
    await reachPublish();
    expect(screen.queryByText('sprayWizard.done.leave')).toBeNull();

    await flush(DONE_EXIT_OFFER_MS);
    fireEvent.click(screen.getByText('sprayWizard.done.leave'));
    // The second road: the first may be the one that is not landing.
    expect(mocks.rootGoBack).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTo).not.toHaveBeenCalled();
  });
});
