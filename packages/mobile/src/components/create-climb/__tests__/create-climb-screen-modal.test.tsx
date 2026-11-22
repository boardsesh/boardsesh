// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

// New climb is a full-height modal route. These pin its ways out and how the
// climb under it changes:
// - the header X and Android's back both leave through the same close, which
//   pops the route (the draft is flushed on unmount) and says it was kept;
// - Android's back is only taken while the editor is the focused screen;
// - loading a draft or starting a new climb changes the route's params in place
//   instead of replacing the route, which would drop the sheet and present a
//   new one.

const state = vi.hoisted(() => ({
  focused: true,
  canGoBack: true,
  back: vi.fn(),
  replace: vi.fn(),
  setParams: vi.fn(),
  push: vi.fn(),
  persist: vi.fn(async () => {}),
  editableWallUuid: undefined as string | undefined,
  saveState: 'ready',
  removeMissingHolds: vi.fn(),
  dismissGhost: vi.fn(),
  ghosts: [] as Array<{ id: number; cx: number; cy: number; r: number }>,
  notify: vi.fn(),
  backListeners: [] as Array<() => boolean>,
  drawer: null as null | {
    onClose: () => void;
    onAddHolds?: () => Promise<void>;
    onRemoveMissingHolds?: () => void;
    onLoadDraft: (climb: Climb) => void;
    onLongPressHold: (holdId: number) => void;
  },
  holdRoleId: null as number | null,
  onStartedNewClimb: null as null | (() => void),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      state.backListeners.push(handler);
      return {
        remove: () => {
          state.backListeners = state.backListeners.filter((listener) => listener !== handler);
        },
      };
    },
  },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-router', () => ({
  useIsFocused: () => state.focused,
  useRouter: () => ({
    canGoBack: () => state.canGoBack,
    back: state.back,
    replace: state.replace,
    setParams: state.setParams,
    push: state.push,
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Button', () => ({ Button: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/create-board-holds', () => ({
  getCreateBoardHolds: () => ({ holdTargets: [], boardWidth: 650, boardHeight: 1000 }),
}));
vi.mock('../../../lib/spray/use-spray-wall', () => ({ useSprayWall: () => ({ isLoading: false }) }));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => '' }));
vi.mock('../spray-climb-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spray-climb-rules')>()),
  editableSprayWallUuidFor: () => state.editableWallUuid,
}));
vi.mock('../use-create-climb-screen', () => ({
  useCreateClimbScreen: ({ onStartedNewClimb }: { onStartedNewClimb: () => void }) => {
    state.onStartedNewClimb = onStartedNewClimb;
    return {
      selectedBrush: 'HAND',
      setSelectedBrush: vi.fn(),
      notifyDraftKeptOnDismiss: state.notify,
      persistWorkingDraft: state.persist,
      saveState: state.saveState,
      missingHoldIds: [42],
      removeMissingHolds: state.removeMissingHolds,
    };
  },
}));
vi.mock('../../../lib/graphql/hooks/use-hold-heatmap', () => ({
  useHoldHeatmap: () => ({ statsByHoldId: new Map() }),
}));
vi.mock('../../../lib/offline/use-catalog-query-source', () => ({
  useCatalogQuerySourceState: () => ({ source: 'network', isResolving: false }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../search/heatmap/heatmap-search-input', () => ({ heatmapSearchInput: () => ({}) }));
vi.mock('../CreateDrawer', () => ({
  CreateDrawer: (props: {
    onClose: () => void;
    onAddHolds?: () => Promise<void>;
    onRemoveMissingHolds?: () => void;
    onLoadDraft: (climb: Climb) => void;
    onLongPressHold: (holdId: number) => void;
  }) => {
    state.drawer = props;
    return null;
  },
}));
vi.mock('../HoldRoleSheet', () => ({
  HoldRoleSheet: ({ holdId }: { holdId: number | null }) => {
    state.holdRoleId = holdId;
    return null;
  },
}));
vi.mock('../use-lost-hold-ghosts', () => ({
  useLostHoldGhosts: () => ({
    ghosts: state.ghosts,
    ghostTargets: [],
    dismissGhost: state.dismissGhost,
    dismissMissingGhosts: state.dismissGhost,
  }),
}));

import { CreateClimbScreen } from '../CreateClimbScreen';

const BOARD = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

const BLANK_CLIMB_PARAMS = {
  boardName: 'kilter',
  layoutId: '1',
  sizeId: '10',
  setIds: '1,2',
  angle: '40',
  forkFrames: undefined,
  forkName: undefined,
  forkDescription: undefined,
  forkCharacteristics: undefined,
  forkParentUuid: undefined,
};

function renderScreen() {
  return render(createElement(CreateClimbScreen, { board: BOARD, forkFrames: 'p1r12', forkName: 'Remixed' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.focused = true;
  state.editableWallUuid = undefined;
  state.saveState = 'ready';
  state.ghosts = [];
  state.persist.mockReset();
  state.persist.mockResolvedValue(undefined);
  state.canGoBack = true;
  state.backListeners = [];
  state.drawer = null;
  state.onStartedNewClimb = null;
  state.holdRoleId = null;
});
afterEach(cleanup);

describe('New climb as a modal route', () => {
  it('leaves on the header X, keeping the draft and saying so', () => {
    renderScreen();
    act(() => state.drawer?.onClose());
    expect(state.back).toHaveBeenCalledOnce();
    expect(state.notify).toHaveBeenCalledOnce();
  });

  it("leaves on Android's back the same way, and takes the press", () => {
    renderScreen();
    expect(state.backListeners).toHaveLength(1);
    let handled = false;
    act(() => {
      handled = state.backListeners[0]?.() ?? false;
    });
    expect(handled).toBe(true);
    expect(state.back).toHaveBeenCalledOnce();
    expect(state.notify).toHaveBeenCalledOnce();
  });

  it("closes the hold-role sheet on Android's back, not the editor under it", () => {
    renderScreen();
    act(() => state.drawer?.onLongPressHold(7));
    expect(state.holdRoleId).toBe(7);
    let handled = false;
    act(() => {
      handled = state.backListeners[0]?.() ?? false;
    });
    expect(handled).toBe(true);
    expect(state.holdRoleId).toBeNull();
    expect(state.back).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
  });

  it('leaves the back press alone while another screen is in front', () => {
    state.focused = false;
    renderScreen();
    expect(state.backListeners).toHaveLength(0);
  });

  it('stops listening for back once the editor goes away', () => {
    const screen = renderScreen();
    screen.unmount();
    expect(state.backListeners).toHaveLength(0);
  });

  it('loads a draft by changing params in place, clearing the remix', () => {
    renderScreen();
    act(() => state.drawer?.onLoadDraft({ uuid: 'draft-1' } as Climb));
    expect(state.setParams).toHaveBeenCalledWith({ ...BLANK_CLIMB_PARAMS, editClimbUuid: 'draft-1' });
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('starts a new climb by changing params in place, dropping the edit and the remix', () => {
    renderScreen();
    act(() => state.onStartedNewClimb?.());
    expect(state.setParams).toHaveBeenCalledWith({ ...BLANK_CLIMB_PARAMS, editClimbUuid: undefined });
    expect(state.replace).not.toHaveBeenCalled();
  });
});

describe('adding missing spray holds from the climb', () => {
  it('awaits a durable climb copy before opening the editor in Add mode', async () => {
    state.editableWallUuid = 'editable-wall';
    let finishPersist: (() => void) | undefined;
    state.persist.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPersist = resolve;
        }),
    );
    renderScreen();
    let pending: Promise<void> | undefined;
    act(() => {
      pending = state.drawer?.onAddHolds?.();
    });
    expect(state.persist).toHaveBeenCalledOnce();
    expect(state.push).not.toHaveBeenCalled();
    await act(async () => {
      finishPersist?.();
      await pending;
    });
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/boards/spray/holds?wallUuid=editable-wall&entry=climb-editor');
    expect(state.back).not.toHaveBeenCalled();
  });

  it('does not open a second task while the climb is publishing', async () => {
    state.editableWallUuid = 'editable-wall';
    state.saveState = 'saving';
    renderScreen();
    await act(async () => {
      await state.drawer?.onAddHolds?.();
    });
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('keeps the climb open when its local save fails', async () => {
    state.editableWallUuid = 'editable-wall';
    state.persist.mockRejectedValue(new Error('Storage is full'));
    renderScreen();
    await act(async () => {
      await state.drawer?.onAddHolds?.();
    });
    expect(state.push).not.toHaveBeenCalled();
    expect(state.back).not.toHaveBeenCalled();
  });

  it('offers no entry for a wall this account cannot edit', () => {
    renderScreen();
    expect(state.drawer?.onAddHolds).toBeUndefined();
  });

  it('does not open after the climb was closed during its local save', async () => {
    state.editableWallUuid = 'editable-wall';
    let finishPersist: (() => void) | undefined;
    state.persist.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPersist = resolve;
        }),
    );
    const view = renderScreen();
    let pending: Promise<void> | undefined;
    act(() => {
      pending = state.drawer?.onAddHolds?.();
    });
    view.unmount();
    await act(async () => {
      finishPersist?.();
      await pending;
    });
    expect(state.push).not.toHaveBeenCalled();
  });
});

it('acknowledges remix ghosts with the removed selections in one action', () => {
  state.ghosts = [{ id: 42, cx: 10, cy: 20, r: 8 }];
  renderScreen();
  act(() => state.drawer?.onRemoveMissingHolds?.());
  expect(state.dismissGhost).toHaveBeenCalledExactlyOnceWith([42]);
  expect(state.removeMissingHolds).toHaveBeenCalledOnce();
});

it('acknowledges missing remix IDs before their geometry has loaded', () => {
  state.ghosts = [];
  renderScreen();
  act(() => state.drawer?.onRemoveMissingHolds?.());
  expect(state.dismissGhost).toHaveBeenCalledExactlyOnceWith([42]);
  expect(state.removeMissingHolds).toHaveBeenCalledOnce();
});
