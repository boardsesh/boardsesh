// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WallPreviewState } from '../wall-kiosk/useWallPreview';

type HostProps = { children?: ReactNode };

const wall = vi.hoisted(() => ({
  activeBoard: null as null | { boardType: string; layoutId: number; hasLeds?: boolean; litByWallDevice?: boolean },
  ledsEnabled: false,
  ledHookArgs: [] as unknown[][],
}));

vi.mock('react-native', () => ({
  View: ({ children }: HostProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: HostProps) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => createElement('button', null, title) }));
vi.mock('../../grade/grade-chip-colors', () => ({ readableTextColor: () => '#000' }));
vi.mock('../wall-kiosk/WallScrubber', () => ({ WallScrubber: () => null }));
vi.mock('../wall-kiosk/WallIdentityBlock', () => ({ WallIdentityBlock: () => null }));
vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ({ takeVirtualWall: vi.fn(), connect: vi.fn(), boardName: 'spray' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { elevatedSurface: '#fff', separator: '#ccc', secondaryLabel: '#666', label: '#111', fill: '#eee' },
    brandColors: { live: '#fa0', historyFill: '#555' },
  }),
}));
vi.mock('../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: 'V5', color: '#ff0' }) }),
}));
vi.mock('../../../hooks/use-typography-styles', () => ({
  useTypographyStyles: () => ({}),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: wall.activeBoard }),
}));
vi.mock('../../../lib/spray/use-spray-wall-leds-enabled', () => ({
  useSprayWallLedsEnabled: (...args: unknown[]) => {
    wall.ledHookArgs.push(args);
    return wall.ledsEnabled;
  },
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/analytics-board-connect', () => ({ trackBoardConnectTapped: vi.fn() }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => 'now' }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32, 10: 40 },
  borderRadius: { md: 8, lg: 12 },
}));

import { WallEmptyState } from '../WallEmptyState';
import { WallChromeRegion } from '../wall-kiosk/WallChromeRegion';

const typeScale = {
  gradeFontSize: 64,
  gradeLineHeight: 68,
  nameFontSize: 40,
  nameLineHeight: 44,
  metaFontSize: 20,
  metaLineHeight: 26,
  stateFontSize: 20,
  stateLineHeight: 26,
};

const idlePreview = { lastLitClimb: null, displayedClimb: null, liveClimb: null } as unknown as WallPreviewState;

function renderKiosk() {
  return render(
    <WallChromeRegion region="rail" mode="idle" preview={idlePreview} typeScale={typeScale} bandWidth={360} />,
  ).container.textContent;
}

const SPRAY_WALL = { boardType: 'spray', layoutId: 7001, hasLeds: false };

beforeEach(() => {
  wall.activeBoard = SPRAY_WALL;
  wall.ledsEnabled = false;
  wall.ledHookArgs = [];
});
afterEach(cleanup);

describe('a spray wall with LEDs set up on this phone', () => {
  beforeEach(() => {
    wall.ledsEnabled = true;
  });

  it('never tells the Wall display this wall has no lights', () => {
    const copy = render(createElement(WallEmptyState)).container.textContent;
    expect(copy).toContain('mobile.boardPresence.wallEmptyBodyWallDevice');
    expect(copy).not.toContain('wallEmptyBodyNoLeds');
    expect(wall.ledHookArgs).toContainEqual(['spray', 7001]);
  });

  it('reads as a dark wall on the kiosk', () => {
    const copy = renderKiosk();
    expect(copy).toContain('mobile.boardPresence.kiosk.wallDark');
    expect(copy).toContain('mobile.boardPresence.kiosk.idleHint');
    expect(copy).not.toContain('nothingUpYet');
    expect(copy).not.toContain('idleHintNoLeds');
  });
});

describe('a spray wall with no LED setup', () => {
  it('still says it has no lights on the Wall display', () => {
    expect(render(createElement(WallEmptyState)).container.textContent).toContain(
      'mobile.boardPresence.wallEmptyBodyNoLeds',
    );
  });

  it('still says nothing is up on the kiosk', () => {
    const copy = renderKiosk();
    expect(copy).toContain('mobile.boardPresence.kiosk.nothingUpYet');
    expect(copy).toContain('mobile.boardPresence.kiosk.idleHintNoLeds');
    expect(copy).not.toContain('wallDark');
  });

  it('keeps the wall-device copy for a wall lit by a wall device', () => {
    wall.activeBoard = { ...SPRAY_WALL, litByWallDevice: true };
    expect(render(createElement(WallEmptyState)).container.textContent).toContain(
      'mobile.boardPresence.wallEmptyBodyWallDevice',
    );
    expect(renderKiosk()).toContain('mobile.boardPresence.kiosk.wallDark');
  });
});

describe('a Kilter board', () => {
  it('keeps its copy on both surfaces', () => {
    wall.activeBoard = { boardType: 'kilter', layoutId: 1, hasLeds: true };
    expect(render(createElement(WallEmptyState)).container.textContent).toContain('mobile.boardPresence.wallEmptyBody');
    const copy = renderKiosk();
    expect(copy).toContain('mobile.boardPresence.kiosk.wallDark');
    expect(copy).toContain('mobile.boardPresence.kiosk.idleHint');
  });
});
