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

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const GymDirectoryClaimLink = (await import('../gym-directory-claim-link')).default;

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
});

describe('GymDirectoryClaimLink', () => {
  it('reports the click with the directory-footer placement and no gym', () => {
    // `directory-footer`, not the old `directory-card`: the prompt renders once
    // under the whole list instead of on every unclaimed row, so the two values
    // count different things and a saved insight must not average them.
    render(<GymDirectoryClaimLink viewerState="signed-out" />);

    fireEvent.click(screen.getByRole('link', { name: 'Find your gym' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'directory-footer', viewerState: 'signed-out', gymUuid: null },
    });
  });

  it('passes a signed-in viewer through unchanged', () => {
    render(<GymDirectoryClaimLink viewerState="signed-in" />);

    fireEvent.click(screen.getByRole('link', { name: 'Find your gym' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'directory-footer', viewerState: 'signed-in', gymUuid: null },
    });
  });

  it('asks the question once, and jumps back to the search box rather than guessing a gym', () => {
    render(<GymDirectoryClaimLink viewerState="signed-out" />);

    expect(screen.getAllByText(/Is this your gym\?/)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Find your gym' }).getAttribute('href')).toBe('#gym-directory-search');
  });
});
