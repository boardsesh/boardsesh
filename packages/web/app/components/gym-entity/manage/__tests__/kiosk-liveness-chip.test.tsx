import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import KioskLivenessChip from '../kiosk-liveness-chip';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Swap the real MUI Tooltip for a thin marker so we can assert on whether a
// tooltip renders at all and what title it was given, without simulating
// hover/focus timing (MUI lazy-mounts the popper only on interaction).
vi.mock('@mui/material/Tooltip', () => ({
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="tooltip" data-title={title}>
      {children}
    </div>
  ),
}));

describe('KioskLivenessChip', () => {
  it('renders "No signal yet" with no tooltip for an unparseable lastSeenAt (regression: previously rendered an Invalid Date tooltip)', () => {
    render(<KioskLivenessChip lastSeenAt="not-a-date" kioskName="Front Desk TV" tvPath="/gym/front-desk" />);

    expect(screen.getByText('No signal yet')).toBeTruthy();
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('renders "No signal yet" with no tooltip for a null lastSeenAt', () => {
    render(<KioskLivenessChip lastSeenAt={null} kioskName="Front Desk TV" tvPath="/gym/front-desk" />);

    expect(screen.getByText('No signal yet')).toBeTruthy();
    expect(screen.queryByTestId('tooltip')).toBeNull();
  });

  it('wraps the chip in a tooltip with a formatted timestamp for a parseable lastSeenAt', () => {
    const lastSeenAt = new Date(Date.now() - 1000).toISOString();

    render(<KioskLivenessChip lastSeenAt={lastSeenAt} kioskName="Front Desk TV" tvPath="/gym/front-desk" />);

    expect(screen.getByText('Live')).toBeTruthy();
    const tooltip = screen.getByTestId('tooltip');
    expect(tooltip.dataset.title).toBe(new Date(lastSeenAt).toLocaleString());
    expect(tooltip.dataset.title).not.toBe('Invalid Date');
  });
});
