import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock dependencies
vi.mock('@/app/components/charts/css-bar-chart', () => ({
  CssBarChart: (props: { ariaLabel?: string }) => (
    <div data-testid="css-bar-chart" aria-label={props.ariaLabel} />
  ),
}));

vi.mock('@/app/components/charts/session-grade-bars', () => ({
  buildSessionGradeBars: () => [],
  SESSION_GRADE_LEGEND: [
    { label: 'Flash', color: '#6B908099' },
    { label: 'Send', color: '#B8524C99' },
    { label: 'Attempt', color: '#D1D5DB99' },
  ],
}));

vi.mock('@/app/lib/grade-colors', () => ({
  formatVGrade: (g: string | null | undefined) => g ?? null,
}));

import SessionOverviewPanel from '../session-overview-panel';

type SessionOverviewPanelProps = React.ComponentProps<typeof SessionOverviewPanel>;

function makeProps(overrides: Partial<SessionOverviewPanelProps> = {}): SessionOverviewPanelProps {
  return {
    participants: [{
      userId: 'user-1',
      displayName: 'Alice',
      avatarUrl: null,
      sends: 5,
      flashes: 2,
      attempts: 3,
    }],
    totalSends: 5,
    totalFlashes: 2,
    totalAttempts: 3,
    tickCount: 8,
    gradeDistribution: [],
    boardTypes: [],
    hardestGrade: null,
    durationMinutes: null,
    goal: null,
    ...overrides,
  };
}

describe('SessionOverviewPanel', () => {
  it('renders single participant with avatar and name', () => {
    render(<SessionOverviewPanel {...makeProps()} />);

    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('1 participant')).toBeTruthy();
  });

  it('renders multiple participants with AvatarGroup and per-user stats breakdown', () => {
    const props = makeProps({
      participants: [
        { userId: 'u1', displayName: 'Alice', avatarUrl: null, sends: 3, flashes: 1, attempts: 1 },
        { userId: 'u2', displayName: 'Bob', avatarUrl: null, sends: 2, flashes: 1, attempts: 2 },
      ],
    });

    render(<SessionOverviewPanel {...props} />);

    expect(screen.getByText('Alice, Bob')).toBeTruthy();
    expect(screen.getByText('2 participants')).toBeTruthy();
    // Per-user stats breakdown
    expect(screen.getByText('3S 1F 1A')).toBeTruthy();
    expect(screen.getByText('2S 1F 2A')).toBeTruthy();
  });

  it('deduplicates participants by userId', () => {
    const duplicate: SessionOverviewPanelProps['participants'][number] = {
      userId: 'user-1',
      displayName: 'Alice',
      avatarUrl: null,
      sends: 5,
      flashes: 2,
      attempts: 3,
    };

    const props = makeProps({
      participants: [duplicate, duplicate],
    });

    render(<SessionOverviewPanel {...props} />);

    // Should show 1 participant, not 2
    expect(screen.getByText('1 participant')).toBeTruthy();
  });

  it('shows sends/flashes/attempts/tickCount chips', () => {
    render(<SessionOverviewPanel {...makeProps()} />);

    expect(screen.getByText('5 sends')).toBeTruthy();
    expect(screen.getByText('2 flashes')).toBeTruthy();
    expect(screen.getByText('3 attempts')).toBeTruthy();
    expect(screen.getByText('8 climbs')).toBeTruthy();
  });

  it('shows duration chip when durationMinutes provided', () => {
    render(<SessionOverviewPanel {...makeProps({ durationMinutes: 45 })} />);

    expect(screen.getByText('45min')).toBeTruthy();
  });

  it('shows hardest grade chip', () => {
    render(<SessionOverviewPanel {...makeProps({ hardestGrade: 'V5' })} />);

    expect(screen.getByText('Hardest: V5')).toBeTruthy();
  });

  it('shows board type chips', () => {
    render(<SessionOverviewPanel {...makeProps({ boardTypes: ['kilter', 'tension'] })} />);

    expect(screen.getByText('Kilter')).toBeTruthy();
    expect(screen.getByText('Tension')).toBeTruthy();
  });

  it('renders grade distribution chart when gradeDistribution is non-empty', () => {
    const props = makeProps({
      gradeDistribution: [{ grade: 'V5', flash: 2, send: 3, attempt: 1 }],
    });

    render(<SessionOverviewPanel {...props} />);

    expect(screen.getByTestId('css-bar-chart')).toBeTruthy();
    expect(screen.getByText('Grade Distribution')).toBeTruthy();
  });

  it('does not render grade distribution chart when gradeDistribution is empty', () => {
    render(<SessionOverviewPanel {...makeProps({ gradeDistribution: [] })} />);

    expect(screen.queryByTestId('css-bar-chart')).toBeNull();
  });

  it('shows goal text when provided', () => {
    render(<SessionOverviewPanel {...makeProps({ goal: 'Send V7' })} />);

    expect(screen.getByText('Goal: Send V7')).toBeTruthy();
  });

  it('shows add participant button when canEditParticipants=true', () => {
    const onAddParticipant = vi.fn();

    render(
      <SessionOverviewPanel
        {...makeProps({ canEditParticipants: true, onAddParticipant })}
      />,
    );

    // The PersonAddOutlined icon button should be rendered
    const addButton = screen.getByRole('button');
    expect(addButton).toBeTruthy();
  });

  it('shows remove button for non-owner participants when canEditParticipants=true', () => {
    const onRemoveParticipant = vi.fn();

    const props = makeProps({
      participants: [
        { userId: 'owner-1', displayName: 'Owner', avatarUrl: null, sends: 3, flashes: 1, attempts: 1 },
        { userId: 'user-2', displayName: 'Guest', avatarUrl: null, sends: 2, flashes: 1, attempts: 2 },
      ],
      ownerUserId: 'owner-1',
      canEditParticipants: true,
      onAddParticipant: vi.fn(),
      onRemoveParticipant,
    });

    render(<SessionOverviewPanel {...props} />);

    // Should have buttons: add participant + remove for non-owner only
    const buttons = screen.getAllByRole('button');
    // Add button + 1 remove button (not for owner)
    expect(buttons.length).toBe(2);
  });

  it('does not show remove button for owner participant', () => {
    const onRemoveParticipant = vi.fn();

    const props = makeProps({
      participants: [
        { userId: 'owner-1', displayName: 'Owner', avatarUrl: null, sends: 3, flashes: 1, attempts: 1 },
      ],
      ownerUserId: 'owner-1',
      canEditParticipants: true,
      onAddParticipant: vi.fn(),
      onRemoveParticipant,
    });

    render(<SessionOverviewPanel {...props} />);

    // Only the add button, no remove button for owner
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(1);
  });

  it('does not show edit buttons when canEditParticipants is false', () => {
    render(<SessionOverviewPanel {...makeProps({ canEditParticipants: false })} />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  describe('formatDuration', () => {
    it('shows minutes for durations under 60', () => {
      render(<SessionOverviewPanel {...makeProps({ durationMinutes: 45 })} />);
      expect(screen.getByText('45min')).toBeTruthy();
    });

    it('shows hours and minutes for durations >= 60', () => {
      render(<SessionOverviewPanel {...makeProps({ durationMinutes: 90 })} />);
      expect(screen.getByText('1h 30min')).toBeTruthy();
    });

    it('shows exact hours without minutes remainder', () => {
      render(<SessionOverviewPanel {...makeProps({ durationMinutes: 120 })} />);
      expect(screen.getByText('2h')).toBeTruthy();
    });
  });

  it('uses singular form for 1 send', () => {
    render(<SessionOverviewPanel {...makeProps({ totalSends: 1 })} />);
    expect(screen.getByText('1 send')).toBeTruthy();
  });

  it('uses singular form for 1 flash', () => {
    render(<SessionOverviewPanel {...makeProps({ totalFlashes: 1 })} />);
    expect(screen.getByText('1 flash')).toBeTruthy();
  });

  it('uses singular form for 1 climb', () => {
    render(<SessionOverviewPanel {...makeProps({ tickCount: 1 })} />);
    expect(screen.getByText('1 climb')).toBeTruthy();
  });

  it('hides flashes chip when totalFlashes is 0', () => {
    render(<SessionOverviewPanel {...makeProps({ totalFlashes: 0 })} />);
    expect(screen.queryByText(/flash/)).toBeNull();
  });

  it('hides attempts chip when totalAttempts is 0', () => {
    render(<SessionOverviewPanel {...makeProps({ totalAttempts: 0 })} />);
    expect(screen.queryByText(/attempt/)).toBeNull();
  });

  it('does not show duration chip when durationMinutes is null', () => {
    render(<SessionOverviewPanel {...makeProps({ durationMinutes: null })} />);
    expect(screen.queryByText(/min/)).toBeNull();
  });
});
