import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const sessionState = vi.hoisted(() => ({ status: 'authenticated' }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'viewer-1' } }, status: sessionState.status }),
}));

vi.mock('@/app/components/gym-entity/report-duplicate-dialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="report-dialog" /> : null),
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const GymReportDuplicateCta = (await import('../gym-report-duplicate-cta')).default;

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
  sessionState.status = 'authenticated';
});

describe('GymReportDuplicateCta', () => {
  it('reports the report-duplicate CTA click', () => {
    render(<GymReportDuplicateCta gymUuid="gym-1" gymName="Boulderwelt" />);

    fireEvent.click(screen.getByRole('button', { name: 'Report a duplicate' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Page CTA Clicked',
      properties: { cta: 'report-duplicate', gymUuid: 'gym-1' },
    });
    expect(screen.getByTestId('report-dialog')).toBeTruthy();
  });

  it('reports nothing for a signed-out visitor, who never sees the flag', () => {
    sessionState.status = 'unauthenticated';

    const { container } = render(<GymReportDuplicateCta gymUuid="gym-1" gymName="Boulderwelt" />);

    expect(container.innerHTML).toBe('');
    expect(trackGymFunnelEvent).not.toHaveBeenCalled();
  });
});
