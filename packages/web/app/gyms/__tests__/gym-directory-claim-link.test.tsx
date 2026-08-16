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
  it('reports the click with the directory-card placement', () => {
    render(<GymDirectoryClaimLink gymUuid="gym-1" gymSlug="boulderwelt" viewerState="signed-out" />);

    fireEvent.click(screen.getByRole('link', { name: 'Is this your gym?' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'directory-card', viewerState: 'signed-out', gymUuid: 'gym-1' },
    });
  });

  it('passes a signed-in viewer through unchanged', () => {
    render(<GymDirectoryClaimLink gymUuid="gym-2" gymSlug="the-climbing-hangar" viewerState="signed-in" />);

    fireEvent.click(screen.getByRole('link', { name: 'Is this your gym?' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'directory-card', viewerState: 'signed-in', gymUuid: 'gym-2' },
    });
  });

  it('is a real link to the gym page, not a click handler on a div', () => {
    render(<GymDirectoryClaimLink gymUuid="gym-1" gymSlug="boulderwelt" viewerState="signed-out" />);
    expect(screen.getByRole('link', { name: 'Is this your gym?' }).getAttribute('href')).toBe('/gym/boulderwelt');
  });
});
