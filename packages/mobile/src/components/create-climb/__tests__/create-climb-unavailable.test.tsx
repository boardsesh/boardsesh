// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loading: false, canGoBack: true, back: vi.fn(), replace: vi.fn(), notify: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-router', () => ({
  useIsFocused: () => true,
  useRouter: () => ({ canGoBack: () => state.canGoBack, back: state.back, replace: state.replace }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', null, 'Loading') }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: {} }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/create-board-holds', () => ({ getCreateBoardHolds: () => null }));
vi.mock('../../../lib/grade-label', () => ({ getDifficultyIdForGradeName: () => null }));
vi.mock('../../../lib/spray/use-spray-wall', () => ({ useSprayWall: () => ({ isLoading: state.loading }) }));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => null }));
vi.mock('../use-create-climb-screen', () => ({
  useCreateClimbScreen: () => ({
    selectedBrush: 'HAND',
    setSelectedBrush: vi.fn(),
    notifyDraftKeptOnDismiss: state.notify,
  }),
}));
vi.mock('../../../lib/graphql/hooks/use-hold-heatmap', () => ({
  useHoldHeatmap: () => ({ statsByHoldId: new Map() }),
}));
vi.mock('../../../lib/offline/use-catalog-query-source', () => ({
  useCatalogQuerySourceState: () => ({ source: 'network', isResolving: false }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));
vi.mock('../../search/heatmap/heatmap-search-input', () => ({ heatmapSearchInput: () => ({}) }));
vi.mock('../CreateDrawer', () => ({ CreateDrawer: () => null }));
vi.mock('../HoldRoleSheet', () => ({ HoldRoleSheet: () => null }));
vi.mock('../use-lost-hold-ghosts', () => ({
  useLostHoldGhosts: () => ({ ghosts: [], ghostTargets: [], dismissGhost: () => {} }),
}));

import { CreateClimbScreen } from '../CreateClimbScreen';

beforeEach(() => {
  vi.clearAllMocks();
  state.loading = false;
  state.canGoBack = true;
});
afterEach(cleanup);

describe('closing the spray climb editor without geometry', () => {
  it.each([false, true])('closes with history while loading=%s', (loading) => {
    state.loading = loading;
    const screen = render(
      createElement(CreateClimbScreen, {
        board: { boardName: 'spray', layoutId: 1000000, sizeId: 1, setIds: '1', angle: 40 },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'actions.close' }));
    expect(state.back).toHaveBeenCalledOnce();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalledOnce();
  });

  it.each([false, true])('returns a cold route to climbs while loading=%s', (loading) => {
    state.loading = loading;
    state.canGoBack = false;
    const screen = render(
      createElement(CreateClimbScreen, {
        board: { boardName: 'spray', layoutId: 1000000, sizeId: 1, setIds: '1', angle: 40 },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'actions.close' }));
    expect(state.replace).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(state.back).not.toHaveBeenCalled();
    expect(state.notify).toHaveBeenCalledOnce();
  });
});
