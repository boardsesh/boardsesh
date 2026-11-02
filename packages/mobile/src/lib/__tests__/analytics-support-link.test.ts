import { describe, it, expect, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => analytics);

import { trackSupportLinkTapped } from '../analytics-support-link';

describe('trackSupportLinkTapped', () => {
  it('sends the event name and surface the donation funnel reads', () => {
    trackSupportLinkTapped('acknowledgements');

    expect(analytics.track).toHaveBeenCalledWith('Support Link Tapped', { surface: 'acknowledgements' });
  });

  it('adds the way of giving when the surface offered a choice', () => {
    trackSupportLinkTapped('home-card', 'once');

    expect(analytics.track).toHaveBeenCalledWith('Support Link Tapped', { surface: 'home-card', cadence: 'once' });
  });
});
