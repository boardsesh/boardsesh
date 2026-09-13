// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

const gymBoards = vi.hoisted(() => ({ data: undefined as UserBoard[] | undefined }));

type PressableMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel }: PressableMockProps) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join(',')}` : key,
  }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      secondaryBackground: '#EEE',
      tertiaryBackground: '#DDD',
    },
    brandColors: { primary: '#7C3AED' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { sm: 8, md: 12, lg: 16 },
}));
vi.mock('../../../lib/graphql/hooks/use-gym-boards', () => ({ useGymBoards: () => gymBoards }));

import { GymWallSwitcher } from '../GymWallSwitcher';

function board(overrides: Partial<UserBoard>): UserBoard {
  return {
    uuid: 'board-1',
    name: 'The Pump Station - Kilter',
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    isAngleAdjustable: true,
    hasLeds: true,
    gymUuid: 'gym-1',
    gymName: 'The Pump Station',
    ...overrides,
  } as unknown as UserBoard;
}

const ACTIVE = board({ uuid: 'active-board' });

describe('GymWallSwitcher', () => {
  beforeEach(() => {
    gymBoards.data = undefined;
    vi.clearAllMocks();
  });

  // The common case by a wide margin. A section header over nothing, or a
  // disabled row, would be worse than the sheet it replaces.
  it('renders nothing when the gym has only the board you are on', () => {
    gymBoards.data = [ACTIVE];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for a board with no gym', () => {
    const homeWall = board({ uuid: 'home', gymUuid: null, gymName: null });

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: homeWall, onSelectBoard: vi.fn() }));

    expect(container.innerHTML).toBe('');
  });

  it('lists the other boards under a heading naming the gym', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', name: 'The Pump Station - Tension', boardType: 'tension' })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.textContent).toContain('gymWalls.header:The Pump Station');
    // The gym prefix is stripped — the heading already said it.
    expect(container.textContent).toContain('Tension');
    expect(container.textContent).not.toContain('The Pump Station - Tension');
  });

  it('hands back the board that was tapped', () => {
    const tension = board({ uuid: 'tension', name: 'The Pump Station - Tension', boardType: 'tension' });
    gymBoards.data = [ACTIVE, tension];
    const onSelectBoard = vi.fn();

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard }));
    fireEvent.click(container.querySelector('button') as HTMLButtonElement);

    expect(onSelectBoard).toHaveBeenCalledWith(tension);
  });

  // The sheet's first detent is already tight, so a gym with a wall of boards
  // must not push its own stats off the bottom.
  it('caps the list and offers the rest behind one more tap', () => {
    gymBoards.data = [
      ACTIVE,
      board({ uuid: 'b1', name: 'One' }),
      board({ uuid: 'b2', name: 'Two' }),
      board({ uuid: 'b3', name: 'Three' }),
      board({ uuid: 'b4', name: 'Four' }),
    ];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.textContent).toContain('gymWalls.showAll:4');
    expect(container.textContent).toContain('One');
    expect(container.textContent).toContain('Two');
    expect(container.textContent).not.toContain('Three');

    const showAll = [...container.querySelectorAll('button')].at(-1) as HTMLButtonElement;
    fireEvent.click(showAll);

    expect(container.textContent).toContain('Three');
    expect(container.textContent).toContain('Four');
  });

  // Two walls set up identically hold the same problems, so the only thing the
  // hop changes is which one is free. Saying so is the useful half of "show
  // them as one entry" without hiding that they are two.
  it('says when the other board holds the same climbs', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'twin', name: 'Twin' })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.textContent).toContain('gymWalls.sameClimbs');
  });

  it('does not claim the same climbs for a different board', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', name: 'Tension', boardType: 'tension', layoutId: 8 })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.textContent).not.toContain('gymWalls.sameClimbs');
  });
});
