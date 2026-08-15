import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const GymPageCtaLink = (await import('../gym-page-cta-link')).default;

beforeEach(() => {
  trackGymFunnelEvent.mockReset();
});

describe('GymPageCtaLink', () => {
  it('keeps the kiosk destination on a real anchor', () => {
    render(<GymPageCtaLink cta="kiosk" gymUuid="gym-1" href="/kiosk/boulderwelt" label="See it on the wall" />);

    const anchor = screen.getByText('See it on the wall').closest('a');
    // A crawler and a JS-off reader must still find the destination — the click
    // handler only adds the event, it never takes the href's job.
    expect(anchor?.getAttribute('href')).toBe('/kiosk/boulderwelt');
  });

  it('reports the kiosk CTA without cancelling the navigation', () => {
    render(<GymPageCtaLink cta="kiosk" gymUuid="gym-1" href="/kiosk/boulderwelt" label="See it on the wall" />);

    const anchor = screen.getByText('See it on the wall').closest('a');
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Page CTA Clicked',
      properties: { cta: 'kiosk', gymUuid: 'gym-1' },
    });
  });

  it('keeps the external website destination, target and rel on a real anchor', () => {
    render(<GymPageCtaLink cta="website" gymUuid="gym-2" href="https://example.com/" label="Visit website" />);

    const anchor = screen.getByText('Visit website').closest('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com/');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('reports the website CTA', () => {
    render(<GymPageCtaLink cta="website" gymUuid="gym-2" href="https://example.com/" label="Visit website" />);

    fireEvent.click(screen.getByText('Visit website'));

    expect(trackGymFunnelEvent).toHaveBeenCalledWith({
      name: 'Gym Page CTA Clicked',
      properties: { cta: 'website', gymUuid: 'gym-2' },
    });
  });
});
