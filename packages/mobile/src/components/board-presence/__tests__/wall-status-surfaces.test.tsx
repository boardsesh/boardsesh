// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wallSelector = vi.hoisted(() => ({
  climb: null as null | { uuid: string; name: string; difficulty: string; frames: string; mirrored?: boolean },
}));

const drawerHost = vi.hoisted(() => ({
  openBoardSheet: vi.fn(),
  boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
}));

const presenceControls = vi.hoisted(() => ({
  enabled: true,
  boardId: 1 as number | null,
}));

const haptics = vi.hoisted(() => ({
  selection: vi.fn(),
}));

type PressableMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
};

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  Pressable: ({ children, onPress, accessibilityLabel }: PressableMockProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${Object.values(opts).join(',')}` : key),
  }),
}));

vi.mock('../../queue-control/use-wall-or-queue-climb', () => ({
  useWallOrQueueCurrentClimb: (localClimb: unknown) => wallSelector.climb ?? localClimb,
}));

vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => drawerHost,
}));

vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: presenceControls.enabled, boardId: presenceControls.boardId }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      secondaryBackground: '#f2f2f7',
      separator: '#ccc',
    },
    brandColors: { warning: '#B45309' },
  }),
}));

vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { full: 999 },
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressableMockProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('../../queue-control/AccessoryClimbThumbnail', () => ({
  AccessoryClimbThumbnail: ({
    climb,
    boardConfig,
    size,
  }: {
    climb: { frames?: string; mirrored?: boolean };
    boardConfig?: { boardName?: string } | null;
    size?: number;
  }) =>
    createElement('span', {
      'data-thumb': 'true',
      'data-frames': climb.frames ?? '',
      'data-mirrored': String(climb.mirrored ?? false),
      'data-board-name': boardConfig?.boardName ?? '',
      'data-size': String(size ?? ''),
    }),
}));

import { WallStrip } from '../WallStrip';
import { SidebarWallCell } from '../../navigation/SidebarWallCell';

function litWallClimb() {
  return {
    uuid: 'climb-1',
    name: 'Moon Patrol',
    difficulty: 'V6',
    frames: 'lit-frames',
    mirrored: true,
  };
}

describe('wall status surfaces', () => {
  beforeEach(() => {
    wallSelector.climb = null;
    presenceControls.enabled = true;
    presenceControls.boardId = 1;
    drawerHost.openBoardSheet.mockClear();
    haptics.selection.mockClear();
  });

  it('WallStrip renders the lit wall climb and opens the board sheet', () => {
    wallSelector.climb = litWallClimb();

    const { container, getByLabelText } = render(createElement(WallStrip));

    expect(container.textContent).toContain('boardPresence.open');
    expect(container.textContent).toContain('Moon Patrol');
    expect(container.textContent).toContain('V6');
    expect(container.querySelector('[data-thumb="true"]')?.getAttribute('data-frames')).toBe('lit-frames');
    expect(container.querySelector('[data-thumb="true"]')?.getAttribute('data-mirrored')).toBe('true');
    expect(container.querySelector('[data-thumb="true"]')?.getAttribute('data-board-name')).toBe('kilter');

    fireEvent.click(getByLabelText('boardPresence.openAriaWithClimb:Moon Patrol'));

    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(drawerHost.openBoardSheet).toHaveBeenCalledTimes(1);
  });

  it('WallStrip renders the dark state when no wall climb is selected', () => {
    const { container, getByLabelText } = render(createElement(WallStrip));

    expect(getByLabelText('boardPresence.openAria')).not.toBeNull();
    expect(container.textContent).toContain('boardPresence.railDark');
    expect(container.querySelector('[data-icon="lightbulb"]')).not.toBeNull();
    expect(container.querySelector('[data-thumb="true"]')).toBeNull();
    expect(container.textContent).not.toContain('V6');
  });

  it('SidebarWallCell renders nothing until board presence is active and bound', () => {
    presenceControls.enabled = false;
    const disabledRender = render(createElement(SidebarWallCell));
    expect(disabledRender.container.textContent).toBe('');

    presenceControls.enabled = true;
    presenceControls.boardId = null;
    const unboundRender = render(createElement(SidebarWallCell));
    expect(unboundRender.container.textContent).toBe('');
  });

  it('SidebarWallCell renders lit and dark board-presence states', () => {
    wallSelector.climb = litWallClimb();
    const litRender = render(createElement(SidebarWallCell));

    expect(litRender.container.textContent).toContain('boardPresence.open');
    expect(litRender.container.textContent).toContain('V6');
    expect(litRender.container.querySelector('[data-thumb="true"]')?.getAttribute('data-size')).toBe('36');

    fireEvent.click(litRender.getByLabelText('boardPresence.openAriaWithClimb:Moon Patrol'));
    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(drawerHost.openBoardSheet).toHaveBeenCalledTimes(1);

    wallSelector.climb = null;
    const darkRender = render(createElement(SidebarWallCell));

    expect(darkRender.getByLabelText('boardPresence.railDark')).not.toBeNull();
    expect(darkRender.container.querySelector('[data-icon="lightbulb"]')).not.toBeNull();
    expect(darkRender.container.querySelector('[data-thumb="true"]')).toBeNull();
  });
});
