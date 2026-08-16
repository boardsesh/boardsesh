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

vi.mock('@/app/components/gym-entity/claim-gym-dialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="claim-dialog" /> : null),
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

const GymClaimCta = (await import('../gym-claim-cta')).default;

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
});

describe('GymClaimCta — gym-page placement', () => {
  it('reports the click with the server-derived viewer state', () => {
    render(<GymClaimCta gymUuid="gym-1" gymName="Boulderwelt" website={null} viewerState="signed-in" />);

    fireEvent.click(screen.getByRole('button', { name: 'Claim this gym' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledTimes(1);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'gym-page', viewerState: 'signed-in', gymUuid: 'gym-1' },
    });
  });

  it('passes a signed-out viewer through unchanged rather than inferring one', () => {
    // Unreachable today — the resolver's `canClaim` requires an authenticated
    // user, so the server never renders this CTA for a signed-out visitor. The
    // prop is wired end to end so #3672's anonymous CTA reports the truth
    // without touching this component.
    render(<GymClaimCta gymUuid="gym-1" gymName="Boulderwelt" website={null} viewerState="signed-out" />);

    fireEvent.click(screen.getByRole('button', { name: 'Claim this gym' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Claim CTA Clicked',
      properties: { placement: 'gym-page', viewerState: 'signed-out', gymUuid: 'gym-1' },
    });
  });

  it('opens the dialog as well as reporting', () => {
    render(<GymClaimCta gymUuid="gym-1" gymName="Boulderwelt" website={null} viewerState="signed-in" />);

    expect(screen.queryByTestId('claim-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Claim this gym' }));
    expect(screen.getByTestId('claim-dialog')).toBeTruthy();
  });
});
