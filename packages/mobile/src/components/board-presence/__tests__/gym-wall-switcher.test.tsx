// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

const gymBoards = vi.hoisted(() => ({ data: undefined as UserBoard[] | undefined }));
const recentClimb = vi.hoisted(() => ({ value: null as { frames: string; angle: number } | null }));

type PressableMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'aria-label': accessibilityLabel }, children),
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
// The row's board art and the query behind it have their own homes; here we only
// care that a row renders one.
vi.mock('../../queue-control/AccessoryClimbThumbnail', () => ({
  AccessoryClimbThumbnail: () => createElement('div', { 'data-board-thumbnail': 'true' }),
}));
vi.mock('../../../lib/graphql/hooks/use-board-recent-climb', () => ({
  useBoardRecentClimb: () => recentClimb.value,
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
    recentClimb.value = null;
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

  // The gym's name is the region's accessible name, not visible copy: the sheet
  // header already says which gym you are at, and the act of opening the list is
  // its heading.
  it('names the gym for screen readers without spending a line on it', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', name: 'The Pump Station - Tension', boardType: 'tension' })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(
      container.querySelector('[aria-label="mobile.boardPresence.gymWalls.header:The Pump Station"]'),
    ).toBeTruthy();
    expect(container.textContent).not.toContain('gymWalls.header');
    // The gym prefix is stripped from the row title — the sheet header said it.
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

  // Straight from a QA screenshot: the row read "Original 12×12 with kickboard ·
  // Original 12×12 with kickboard · 45°". The disambiguated subtitle already
  // leads with what the board is, so the row must compose onto it, not describe
  // the board a second time.
  it('never prints what the board is twice', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'other', name: 'Other', sizeId: 14 })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    const text = container.textContent ?? '';
    const firstConfig = text.indexOf('Original');
    expect(firstConfig).toBeGreaterThanOrEqual(0);
    // The board's own name/config appears once per row, not twice.
    expect(text.indexOf('Original', firstConfig + 1)).toBe(-1);
  });

  // ...and it must not print the angle twice either, which happens when two
  // boards collide on everything but their angle and the disambiguator has
  // already appended it.
  it('does not repeat an angle the subtitle already carries', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'a', name: 'A', angle: 25 }), board({ uuid: 'b', name: 'B', angle: 45 })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    const text = container.textContent ?? '';
    expect(text).not.toContain('25° · 25°');
    expect(text).not.toContain('45° · 45°');
  });

  it('does not claim the same climbs for a different board', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', name: 'Tension', boardType: 'tension', layoutId: 8 })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.textContent).not.toContain('gymWalls.sameClimbs');
  });

  // QA asked for the board itself in the row, lit with what is on it — the
  // generic glyph this replaces was the same picture on every row.
  it('shows board art for each board', () => {
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', name: 'Tension', boardType: 'tension' })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.querySelectorAll('[data-board-thumbnail]')).toHaveLength(1);
  });

  // A board nobody has lit yet still gets its own art, just bare.
  it('shows board art even with no history to light it with', () => {
    recentClimb.value = null;
    gymBoards.data = [ACTIVE, board({ uuid: 'tension', name: 'Tension', boardType: 'tension' })];

    const { container } = render(createElement(GymWallSwitcher, { activeBoard: ACTIVE, onSelectBoard: vi.fn() }));

    expect(container.querySelector('[data-board-thumbnail]')).toBeTruthy();
  });
});
