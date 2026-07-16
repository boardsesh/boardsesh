import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { SessionSummary } from '@boardsesh/shared-schema';
import SessionSummaryDialog from '../session-summary-dialog';

// Translate keys to themselves so assertions can target them directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('../session-summary-view', () => ({
  default: () => <div data-testid="summary-view" />,
}));

const mockUseSession = vi.fn();
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}));

vi.mock('@/app/hooks/use-healthkit-sync', () => ({
  useHealthKitSync: () => ({ available: false, state: 'idle', save: vi.fn() }),
  useHealthKitAutoSync: () => ({ enabled: false, loaded: true }),
}));

const mockMutate = vi.fn();
vi.mock('@/app/hooks/use-update-session', () => ({
  useUpdateSession: () => ({ mutate: mockMutate }),
}));

const makeSummary = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    sessionId: 'session-1',
    totalSends: 5,
    totalFlashes: 2,
    totalAttempts: 3,
    gradeDistribution: [],
    participants: [],
    goal: null,
    notes: null,
    ...overrides,
  }) as SessionSummary;

describe('SessionSummaryDialog notes field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutate.mockReset();
    mockUseSession.mockReturnValue({ status: 'authenticated', data: { user: { id: '1' } } });
  });

  it('renders the notes input when authenticated', () => {
    render(<SessionSummaryDialog summary={makeSummary()} onDismiss={vi.fn()} />);
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.getByText('summary.commentHelper')).toBeTruthy();
  });

  it('does not render the notes input when anonymous', () => {
    mockUseSession.mockReturnValue({ status: 'unauthenticated', data: null });
    render(<SessionSummaryDialog summary={makeSummary()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('fires updateSession with the trimmed value on a dirty dismiss', () => {
    const onDismiss = vi.fn();
    render(<SessionSummaryDialog summary={makeSummary()} onDismiss={onDismiss} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Crushed my project  ' } });
    fireEvent.click(screen.getByText('summary.done'));

    expect(mockMutate).toHaveBeenCalledWith({ sessionId: 'session-1', notes: 'Crushed my project' });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('does not fire updateSession on a clean dismiss', () => {
    const onDismiss = vi.fn();
    render(<SessionSummaryDialog summary={makeSummary({ notes: 'existing notes' })} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('summary.done'));

    expect(mockMutate).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it('sends null when clearing existing notes', () => {
    render(<SessionSummaryDialog summary={makeSummary({ notes: 'existing notes' })} onDismiss={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.click(screen.getByText('summary.done'));

    expect(mockMutate).toHaveBeenCalledWith({ sessionId: 'session-1', notes: null });
  });

  it('treats whitespace-only edits over existing notes as clearing to null', () => {
    render(<SessionSummaryDialog summary={makeSummary({ notes: 'existing notes' })} onDismiss={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('summary.done'));

    expect(mockMutate).toHaveBeenCalledWith({ sessionId: 'session-1', notes: null });
  });
});
