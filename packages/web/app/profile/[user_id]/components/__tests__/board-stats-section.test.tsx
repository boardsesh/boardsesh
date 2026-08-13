import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import BoardStatsSection from '../board-stats-section';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock BoardImportPrompt to a simple stub so we can detect when it renders
vi.mock('@/app/components/board-entity/board-import-prompt', () => ({
  default: ({ boardType }: { boardType: string }) => (
    <div data-testid="board-import-prompt" data-board-type={boardType} />
  ),
}));

// Mock the CSS module
vi.mock('../../profile-page.module.css', () => ({
  default: {},
}));

const defaultProps = {
  selectedBoard: 'kilter',
  loading: false,
  filteredLogbook: [],
  isOwnProfile: false,
};

describe('BoardStatsSection empty state conditional rendering', () => {
  it('shows loading spinner while aggregated data is loading', () => {
    render(<BoardStatsSection {...defaultProps} loading />);

    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

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
    render(<BoardStatsSection {...defaultProps} isOwnProfile selectedBoard="kilter" />);

    const prompt = screen.getByTestId('board-import-prompt');
    expect(prompt).toBeTruthy();
    expect(prompt.getAttribute('data-board-type')).toBe('kilter');
    expect(screen.queryByText('No climbing data for this period')).toBeNull();
  });

  it('shows BoardImportPrompt for own profile with no data on tension', () => {
    render(<BoardStatsSection {...defaultProps} isOwnProfile selectedBoard="tension" />);

    const prompt = screen.getByTestId('board-import-prompt');
    expect(prompt).toBeTruthy();
    expect(prompt.getAttribute('data-board-type')).toBe('tension');
    expect(screen.queryByText('No climbing data for this period')).toBeNull();
  });

  it('shows EmptyState for own profile with no data on moonboard', () => {
    render(<BoardStatsSection {...defaultProps} isOwnProfile selectedBoard="moonboard" />);

    expect(screen.getByText('No climbing data for this period')).toBeTruthy();
    expect(screen.queryByTestId('board-import-prompt')).toBeNull();
  });

  it('renders nothing when filtered logbook has data', () => {
    const logbookEntry = {
      climbed_at: '2024-01-01',
      difficulty: 10,
      tries: 1,
      angle: 40,
      status: 'send' as const,
      climbUuid: 'uuid-1',
    };

    const { container } = render(
      <BoardStatsSection {...defaultProps} isOwnProfile selectedBoard="kilter" filteredLogbook={[logbookEntry]} />,
    );

    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('board-import-prompt')).toBeNull();
    expect(screen.queryByText('No climbing data for this period')).toBeNull();
  });
});
