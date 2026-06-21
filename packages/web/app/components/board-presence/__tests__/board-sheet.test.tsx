import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, fireEvent } from '@testing-library/react';
import React, { createElement } from 'react';
import type { BoardPresenceClimb, BoardPresenceStats } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

const presence = vi.hoisted(() => ({
  currentClimb: null as BoardPresenceClimb | null,
  history: [] as BoardPresenceClimb[],
  stats: null as BoardPresenceStats | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceCurrent: () => ({
    currentClimb: presence.currentClimb,
    previousClimb: null,
    undoTarget: null,
    isLive: true,
  }),
  useBoardPresenceFeed: () => ({ history: presence.history, stats: presence.stats }),
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGrade: (grade: string | null | undefined) => grade ?? null,
    getGradeColor: () => '#abcdef',
  }),
}));

import { BoardSheet } from '../board-sheet';

function makeClimb(climbUuid: string, seq: number, overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return {
    climbUuid,
    seq,
    sentAt: '2026-06-09T00:00:00.000Z',
    name: `Climb ${climbUuid}`,
    grade: 'V5',
    angle: 40,
    setter: 'Some Setter',
    sentByDisplayName: 'Marco',
    ...overrides,
  };
}

const noop = () => {};
const SWITCH_BOARD_ARIA = tFromCatalog('session', 'boardPresence.switchBoardAria');
const CLOSE_ARIA = tFromCatalog('session', 'boardPresence.close');
const EMPTY_TITLE = tFromCatalog('session', 'boardPresence.emptyTitle');
const HISTORY_HEADER = tFromCatalog('session', 'boardPresence.historyHeader');

describe('BoardSheet', () => {
  beforeEach(() => {
    presence.currentClimb = null;
    presence.history = [];
    presence.stats = null;
  });

  it('renders nothing visible when closed', () => {
    const { queryByText } = render(
      createElement(BoardSheet, {
        open: false,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onSwitchBoard: noop,
      }),
    );
    // MUI Drawer keeps content unmounted/hidden when closed.
    expect(queryByText(EMPTY_TITLE)).toBeNull();
  });

  it('renders the empty state when no climb is on the wall', () => {
    const { getByText } = render(
      createElement(BoardSheet, {
        open: true,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onSwitchBoard: noop,
      }),
    );
    expect(getByText(EMPTY_TITLE)).not.toBeNull();
  });

  it('renders the hero, stats and history when there is wall activity', () => {
    presence.currentClimb = makeClimb('c1', 3);
    presence.history = [makeClimb('c1', 3), makeClimb('c0', 2, { name: 'Older Climb' })];
    presence.stats = {
      climbsSentCount: 14,
      distinctClimbersCount: 5,
      hardestGrade: 'V9',
      topGrade: 'V5',
      lastSentAt: null,
    };

    const { getByText, getAllByText, queryByText } = render(
      createElement(BoardSheet, {
        open: true,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onSwitchBoard: noop,
      }),
    );

    // Hero climb name + history item name both render.
    expect(getAllByText('Climb c1').length).toBeGreaterThan(0);
    expect(getByText('Older Climb')).not.toBeNull();
    // Stats tile value.
    expect(getByText('14')).not.toBeNull();
    expect(getByText(HISTORY_HEADER)).not.toBeNull();
    // No empty state when there is a current climb.
    expect(queryByText(EMPTY_TITLE)).toBeNull();
  });

  it('fires onSwitchBoard from the separated footer control', () => {
    const onSwitchBoard = vi.fn();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        open: true,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onSwitchBoard,
      }),
    );
    fireEvent.click(getByLabelText(SWITCH_BOARD_ARIA));
    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
  });

  it('fires onClose from the header close button', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        open: true,
        boardLabel: 'Garage Wall',
        onClose,
        onSwitchBoard: noop,
      }),
    );
    fireEvent.click(getByLabelText(CLOSE_ARIA));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
