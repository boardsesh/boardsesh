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
  notify: vi.fn(),
  backListeners: [] as Array<() => boolean>,
  drawer: null as null | { onClose: () => void; onLoadDraft: (climb: Climb) => void },
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
vi.mock('../use-create-climb-screen', () => ({
  useCreateClimbScreen: ({ onStartedNewClimb }: { onStartedNewClimb: () => void }) => {
    state.onStartedNewClimb = onStartedNewClimb;
    return { selectedBrush: 'HAND', setSelectedBrush: vi.fn(), notifyDraftKeptOnDismiss: state.notify };
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
  CreateDrawer: (props: { onClose: () => void; onLoadDraft: (climb: Climb) => void }) => {
    state.drawer = props;
    return null;
  },
}));
vi.mock('../HoldRoleSheet', () => ({ HoldRoleSheet: () => null }));
vi.mock('../use-lost-hold-ghosts', () => ({
  useLostHoldGhosts: () => ({ ghosts: [], ghostTargets: [], dismissGhost: () => {} }),
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
  state.canGoBack = true;
  state.backListeners = [];
  state.drawer = null;
  state.onStartedNewClimb = null;
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
