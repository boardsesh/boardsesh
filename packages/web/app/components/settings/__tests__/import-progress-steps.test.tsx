import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { ImportProgressSteps, STEP_ORDER, STEP_LABELS, type ImportProgress } from '../aurora-credentials-section';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

describe('ImportProgressSteps', () => {
  it('renders all step labels', () => {
    render(<ImportProgressSteps progress={null} />);

    for (const step of STEP_ORDER) {
      expect(screen.getByText(STEP_LABELS[step])).toBeTruthy();
    }
  });

  it('shows all steps as pending when progress is null', () => {
    const { container } = render(<ImportProgressSteps progress={null} />);

    // All steps should have the disabled icon (RadioButtonUnchecked)
    const disabledIcons = container.querySelectorAll('[data-testid="RadioButtonUncheckedOutlinedIcon"]');
    expect(disabledIcons.length).toBe(STEP_ORDER.length);
  });

  it('marks earlier steps as complete and current step as active', () => {
    const progress: ImportProgress = { step: 'ascents', current: 5, total: 10 };
    const { container } = render(<ImportProgressSteps progress={progress} />);

    // Steps before 'ascents' (resolving, dedup) should be complete
    const checkIcons = container.querySelectorAll('[data-testid="CheckCircleOutlinedIcon"]');
    const ascentIndex = STEP_ORDER.indexOf('ascents');
    expect(checkIcons.length).toBe(ascentIndex);

    // Active step should have a CircularProgress spinner
    const spinners = container.querySelectorAll('[role="progressbar"]');
    expect(spinners.length).toBeGreaterThanOrEqual(1);
  });

  it('displays count text when current and total are present', () => {
    const progress: ImportProgress = { step: 'ascents', current: 3, total: 15 };
    render(<ImportProgressSteps progress={progress} />);

    expect(screen.getByText(/Importing ascents.*\(3 \/ 15\)/)).toBeTruthy();
  });

  it('shows indeterminate progress bar for active step without counts', () => {
    const progress: ImportProgress = { step: 'resolving', message: 'Resolving...' };
    const { container } = render(<ImportProgressSteps progress={progress} />);

    // Should have an indeterminate LinearProgress
    const linearBars = container.querySelectorAll('.MuiLinearProgress-indeterminate');
    expect(linearBars.length).toBe(1);
  });

  it('shows determinate progress bar when counts are present', () => {
    const progress: ImportProgress = { step: 'attempts', current: 50, total: 100 };
    const { container } = render(<ImportProgressSteps progress={progress} />);

    const determinateBars = container.querySelectorAll('.MuiLinearProgress-determinate');
    expect(determinateBars.length).toBe(1);
  });

  it('marks steps after current as pending with disabled styling', () => {
    const progress: ImportProgress = { step: 'resolving', message: 'hi' };
    const { container } = render(<ImportProgressSteps progress={progress} />);

    // Steps after resolving should have the disabled icon
    const disabledIcons = container.querySelectorAll('[data-testid="RadioButtonUncheckedOutlinedIcon"]');
    const resolvingIndex = STEP_ORDER.indexOf('resolving');
    const pendingCount = STEP_ORDER.length - resolvingIndex - 1;
    expect(disabledIcons.length).toBe(pendingCount);
  });

  it('handles last step being active', () => {
    const progress: ImportProgress = { step: 'circuits', message: 'Importing circuits...' };
    const { container } = render(<ImportProgressSteps progress={progress} />);

    // All steps before circuits should be complete
    const checkIcons = container.querySelectorAll('[data-testid="CheckCircleOutlinedIcon"]');
    expect(checkIcons.length).toBe(STEP_ORDER.length - 1);

    // No pending icons
    const disabledIcons = container.querySelectorAll('[data-testid="RadioButtonUncheckedOutlinedIcon"]');
    expect(disabledIcons.length).toBe(0);
  });

  it('renders progress at 0%', () => {
    const progress: ImportProgress = { step: 'ascents', current: 0, total: 50 };
    render(<ImportProgressSteps progress={progress} />);

    expect(screen.getByText(/\(0 \/ 50\)/)).toBeTruthy();
  });

  it('renders progress at 100%', () => {
    const progress: ImportProgress = { step: 'circuits', current: 10, total: 10 };
    render(<ImportProgressSteps progress={progress} />);

    expect(screen.getByText(/\(10 \/ 10\)/)).toBeTruthy();
  });
});
