import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock BoardImportPrompt to a simple stub so we can detect when it renders
vi.mock('@/app/components/settings/board-import-prompt', () => ({
  default: ({ boardType }: { boardType: string }) => (
    <div data-testid="board-import-prompt" data-board-type={boardType} />
  ),
}));

// Mock the CSS module
vi.mock('../../profile-page.module.css', () => ({
  default: {},
}));

// Mock CssBarChart components
vi.mock('@/app/components/charts/css-bar-chart', () => ({
  CssBarChart: () => <div data-testid="css-bar-chart" />,
  GroupedBarChart: () => <div data-testid="grouped-bar-chart" />,
}));

// Mock MUI DatePicker to avoid LocalizationProvider requirement
vi.mock('@mui/x-date-pickers/DatePicker', () => ({
  DatePicker: () => <input data-testid="date-picker" />,
}));

import BoardStatsSection from '../board-stats-section';

const defaultProps = {
  selectedBoard: 'kilter',
  onBoardChange: vi.fn(),
  timeframe: 'all' as const,
  onTimeframeChange: vi.fn(),
  fromDate: '',
  onFromDateChange: vi.fn(),
  toDate: '',
  onToDateChange: vi.fn(),
  loadingStats: false,
  filteredLogbook: [],
  weeklyBars: null,
  isOwnProfile: false,
  weeklyFromDate: '',
  onWeeklyFromDateChange: vi.fn(),
  weeklyToDate: '',
  onWeeklyToDateChange: vi.fn(),
};

describe('BoardStatsSection empty state conditional rendering', () => {
  it('shows EmptyState for other users profile with no data on kilter', () => {
    render(<BoardStatsSection {...defaultProps} isOwnProfile={false} selectedBoard="kilter" />);

    expect(screen.getByText('No climbing data for this period')).toBeTruthy();
    expect(screen.queryByTestId('board-import-prompt')).toBeNull();
  });

  it('shows EmptyState for other users profile with no data on tension', () => {
    render(<BoardStatsSection {...defaultProps} isOwnProfile={false} selectedBoard="tension" />);

    expect(screen.getByText('No climbing data for this period')).toBeTruthy();
    expect(screen.queryByTestId('board-import-prompt')).toBeNull();
  });

  it('shows BoardImportPrompt for own profile with no data on kilter', () => {
    render(<BoardStatsSection {...defaultProps} isOwnProfile={true} selectedBoard="kilter" />);

    const prompt = screen.getByTestId('board-import-prompt');
    expect(prompt).toBeTruthy();
    expect(prompt.getAttribute('data-board-type')).toBe('kilter');
    expect(screen.queryByText('No climbing data for this period')).toBeNull();
  });

  it('shows BoardImportPrompt for own profile with no data on tension', () => {
    render(<BoardStatsSection {...defaultProps} isOwnProfile={true} selectedBoard="tension" />);

    const prompt = screen.getByTestId('board-import-prompt');
    expect(prompt).toBeTruthy();
    expect(prompt.getAttribute('data-board-type')).toBe('tension');
    expect(screen.queryByText('No climbing data for this period')).toBeNull();
  });

  it('shows EmptyState for own profile with no data on moonboard', () => {
    render(<BoardStatsSection {...defaultProps} isOwnProfile={true} selectedBoard="moonboard" />);

    expect(screen.getByText('No climbing data for this period')).toBeTruthy();
    expect(screen.queryByTestId('board-import-prompt')).toBeNull();
  });

  it('shows charts when logbook has data regardless of isOwnProfile', () => {
    const logbookEntry = {
      climbed_at: '2024-01-01',
      difficulty: 10,
      tries: 1,
      angle: 40,
      status: 'send' as const,
      climbUuid: 'uuid-1',
    };

    const weeklyBars = [
      {
        key: 'W1',
        label: 'W1',
        segments: [{ value: 1, color: 'rgba(255,235,59,0.8)', label: '4a' }],
      },
    ];

    render(
      <BoardStatsSection
        {...defaultProps}
        isOwnProfile={true}
        selectedBoard="kilter"
        filteredLogbook={[logbookEntry]}
        weeklyBars={weeklyBars}
      />,
    );

    expect(screen.getByTestId('css-bar-chart')).toBeTruthy();
    expect(screen.queryByTestId('board-import-prompt')).toBeNull();
    expect(screen.queryByText('No climbing data for this period')).toBeNull();
  });
});
