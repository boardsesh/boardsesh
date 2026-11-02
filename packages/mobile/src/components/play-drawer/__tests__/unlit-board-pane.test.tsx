// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const lights = vi.hoisted(() => ({ tap: false, reads: 0 }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  PixelRatio: { get: () => 2 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => null }));
vi.mock('../../ChromeIconButton', () => ({ useChromeIconButtonSize: () => 44 }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../lib/board-details', () => ({ getBoardRenderData: () => null }));
vi.mock('../../../lib/spray/use-spray-wall-token', () => ({ useSprayWallToken: () => 0 }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'gray' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));
vi.mock('../play-drawer-layout', () => ({ computeContainedBoardSize: () => ({ width: 1, height: 1 }) }));
vi.mock('../PlayDrawerActionBar', () => ({ ACTION_BAR_SECONDARY_ROW_HEIGHT: 48 }));
vi.mock('../use-climb-change-lights', () => ({
  useDrivingWall: () => {
    lights.reads += 1;
    return lights.tap;
  },
}));

import { UnlitBoardPane } from '../UnlitBoardPane';

const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 };

describe('UnlitBoardPane', () => {
  beforeEach(() => {
    cleanup();
    lights.tap = false;
    lights.reads = 0;
  });

  // 2.7: a tap previews by default, so the empty pane says so.
  it('says a tap previews while a list tap stays off the wall', () => {
    const { container } = render(<UnlitBoardPane boardConfig={boardConfig} paneTopInset={false} />);
    expect(container.textContent).toBe('playView.paneEmpty.unlitHint');
    expect(lights.reads).toBeGreaterThan(0);
  });

  // A live drive (Always drive the wall's included): the tap lights.
  it('says a tap lights it where a list tap lights the wall', () => {
    lights.tap = true;
    const { container } = render(<UnlitBoardPane boardConfig={boardConfig} paneTopInset={false} />);
    expect(container.textContent).toBe('playView.paneEmpty.unlitHintLights');
  });
});
