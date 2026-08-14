import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import SessionOverviewPanel, { buildSessionSummaryParts, formatDuration } from '../session-overview-panel';

// Translate the keys the component renders into the English strings the assertions expect.
// Keeps these component-level tests from depending on a real i18n provider.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const count = options?.count as number | undefined;
      const grade = options?.grade as string | undefined;
      const goal = options?.goal as string | undefined;
      const hours = options?.hours as number | undefined;
      const mins = options?.mins as number | undefined;
      switch (key) {
        case 'detail.flashesCount':
          return `${count} ${count === 1 ? 'flash' : 'flashes'}`;
        case 'detail.sendsCount':
          return `${count} ${count === 1 ? 'send' : 'sends'}`;
        case 'detail.attemptsCount':
          return `${count} ${count === 1 ? 'attempt' : 'attempts'}`;
        case 'detail.climbCount':
          return `${count} ${count === 1 ? 'climb' : 'climbs'}`;
        case 'detail.hardestLabel':
          return `Hardest: ${grade}`;
        case 'detail.gradeDistribution':
          return 'Grade Distribution';
        case 'detail.sessionGradeDistribution':
          return 'Session grade distribution';
        case 'overview.goal':
          return `Goal: ${goal}`;
        case 'summary.minutes':
          return `${count}min`;
        case 'summary.hours':
          return `${count}h`;
        case 'summary.hoursAndMinutes':
          return `${hours}h ${mins}min`;
        default:
          return key;
      }
    },
    i18n: { language: 'en-US' },
  }),
}));

// Mock dependencies
vi.mock('@/app/components/charts/css-bar-chart', () => ({
  CssBarChart: (props: { ariaLabel?: string }) => <div data-testid="css-bar-chart" aria-label={props.ariaLabel} />,
}));

vi.mock('@/app/components/charts/session-grade-bars', () => ({
  buildSessionGradeBars: () => [],
  SESSION_GRADE_LEGEND: [
    { label: 'Flash', color: '#6B908099' },
    { label: 'Send', color: '#B8524C99' },
    { label: 'Attempt', color: '#D1D5DB99' },
  ],
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    gradeFormat: 'v-grade',
    formatGrade: (g: string | null | undefined) => g ?? null,
    getGradeColor: vi.fn(),
    loaded: true,
    setGradeFormat: vi.fn(),
  }),
}));

type SessionOverviewPanelProps = React.ComponentProps<typeof SessionOverviewPanel>;

function makeProps(overrides: Partial<SessionOverviewPanelProps> = {}): SessionOverviewPanelProps {
  return {
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
  it('shows sends/flashes/attempts/tickCount chips (sends excludes flashes)', () => {
    render(<SessionOverviewPanel {...makeProps()} />);

    // totalSends=5 includes 2 flashes, so sends chip shows 5-2=3
    expect(screen.getByText('3 sends')).toBeTruthy();
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

  it('renders notes text in full mode', () => {
    render(<SessionOverviewPanel {...makeProps({ notes: 'Great flow day, felt strong on crimps.' })} />);

    expect(screen.getByText('Great flow day, felt strong on crimps.')).toBeTruthy();
  });

  it('renders notes text in compact mode', () => {
    render(<SessionOverviewPanel {...makeProps({ notes: 'Short recap.', compact: true })} />);

    expect(screen.getByText('Short recap.')).toBeTruthy();
  });

  it('does not render a notes row when notes is null', () => {
    render(<SessionOverviewPanel {...makeProps({ notes: null })} />);

    expect(screen.queryByText(/recap/i)).toBeNull();
  });

  it('does not render a notes row when notes is empty', () => {
    const { container } = render(<SessionOverviewPanel {...makeProps({ notes: '' })} />);
    // An empty-string recap should be treated as absent (no NotesOutlined icon row).
    expect(container.querySelector('[data-testid="NotesOutlinedIcon"]')).toBeNull();
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
    render(<SessionOverviewPanel {...makeProps({ totalSends: 1, totalFlashes: 0 })} />);
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

  it('hides sends chip when all sends are flashes', () => {
    render(<SessionOverviewPanel {...makeProps({ totalSends: 3, totalFlashes: 3 })} />);
    expect(screen.getByText('3 flashes')).toBeTruthy();
    expect(screen.queryByText(/send/)).toBeNull();
  });

  it('handles totalFlashes > totalSends gracefully (no negative sends)', () => {
    // Defensive: should not happen in practice, but guard against it
    render(<SessionOverviewPanel {...makeProps({ totalSends: 1, totalFlashes: 3 })} />);
    expect(screen.getByText('3 flashes')).toBeTruthy();
    expect(screen.queryByText(/send/)).toBeNull();
  });

  it('does not show duration chip when durationMinutes is null', () => {
    render(<SessionOverviewPanel {...makeProps({ durationMinutes: null })} />);
    expect(screen.queryByText(/min/)).toBeNull();
  });
});

describe('formatDuration', () => {
  const t = (key: string, options?: Record<string, unknown>) => {
    const count = options?.count as number | undefined;
    const hours = options?.hours as number | undefined;
    const mins = options?.mins as number | undefined;
    if (key === 'summary.minutes') return `${count}min`;
    if (key === 'summary.hours') return `${count}h`;
    if (key === 'summary.hoursAndMinutes') return `${hours}h ${mins}min`;
    return key;
  };

  it('uses minutes branch for durations under 60', () => {
    expect(formatDuration(0, t)).toBe('0min');
    expect(formatDuration(45, t)).toBe('45min');
    expect(formatDuration(59, t)).toBe('59min');
  });

  it('uses exact-hours branch when minutes divides evenly into hours', () => {
    expect(formatDuration(60, t)).toBe('1h');
    expect(formatDuration(120, t)).toBe('2h');
    expect(formatDuration(180, t)).toBe('3h');
  });

  it('uses hours-and-minutes branch when there is a minute remainder', () => {
    expect(formatDuration(61, t)).toBe('1h 1min');
    expect(formatDuration(90, t)).toBe('1h 30min');
    expect(formatDuration(125, t)).toBe('2h 5min');
  });
});

describe('buildSessionSummaryParts', () => {
  const t = (key: string, options?: Record<string, unknown>) => {
    const count = (options?.count as number | undefined) ?? 0;
    const grade = options?.grade as string | undefined;
    if (key === 'detail.flashesCount') return `${count} ${count === 1 ? 'flash' : 'flashes'}`;
    if (key === 'detail.sendsCount') return `${count} ${count === 1 ? 'send' : 'sends'}`;
    if (key === 'detail.attemptsCount') return `${count} ${count === 1 ? 'attempt' : 'attempts'}`;
    if (key === 'detail.climbCount') return `${count} ${count === 1 ? 'climb' : 'climbs'}`;
    if (key === 'detail.hardestLabel') return `Hardest: ${grade}`;
    return key;
  };
  const base = { totalFlashes: 0, totalSends: 0, totalAttempts: 0, tickCount: 0 };

  it('subtracts flashes from sends', () => {
    const parts = buildSessionSummaryParts(
      {
        ...base,
        totalSends: 5,
        totalFlashes: 2,
        tickCount: 5,
      },
      t,
    );
    expect(parts).toContain('2 flashes');
    expect(parts).toContain('3 sends');
  });

  it('omits sends when all sends are flashes', () => {
    const parts = buildSessionSummaryParts(
      {
        ...base,
        totalSends: 3,
        totalFlashes: 3,
        tickCount: 3,
      },
      t,
    );
    expect(parts).toContain('3 flashes');
    expect(parts.find((p) => p.includes('send'))).toBeUndefined();
  });

  it('handles totalFlashes > totalSends gracefully', () => {
    const parts = buildSessionSummaryParts(
      {
        ...base,
        totalSends: 1,
        totalFlashes: 3,
        tickCount: 3,
      },
      t,
    );
    expect(parts).toContain('3 flashes');
    expect(parts.find((p) => p.includes('send'))).toBeUndefined();
  });

  it('includes hardest grade when provided', () => {
    const parts = buildSessionSummaryParts({ ...base, tickCount: 1, hardestGrade: 'V5' }, t);
    expect(parts).toContain('Hardest: V5');
  });

  it('applies formatGrade to hardest grade', () => {
    const parts = buildSessionSummaryParts(
      {
        ...base,
        tickCount: 1,
        hardestGrade: 'V5',
        formatGrade: () => '5c',
      },
      t,
    );
    expect(parts).toContain('Hardest: 5c');
  });
});
