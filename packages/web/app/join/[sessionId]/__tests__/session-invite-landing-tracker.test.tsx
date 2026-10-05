import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';

const trackBeforeNavigation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn(), trackBeforeNavigation }));

const { default: SessionInviteLandingTracker, __resetReportedLandingsForTests } =
  await import('../session-invite-landing-tracker');

beforeEach(() => {
  trackBeforeNavigation.mockClear();
  __resetReportedLandingsForTests();
});

describe('SessionInviteLandingTracker', () => {
  it('reports the landing through the flushing tracker, with the state the page rendered', () => {
    render(<SessionInviteLandingTracker sessionId="session-1" state="dormant" hasHost hasGym={false} />);

    expect(trackBeforeNavigation).toHaveBeenCalledTimes(1);
    expect(trackBeforeNavigation).toHaveBeenCalledWith('Session Invite Page Viewed', {
      sessionId: 'session-1',
      state: 'dormant',
      hasHost: true,
      hasGym: false,
    });
  });

  it('counts a landing once across remounts (StrictMode, back navigation)', () => {
    const first = render(<SessionInviteLandingTracker sessionId="session-1" state="live" hasHost hasGym />);
    first.unmount();
    render(<SessionInviteLandingTracker sessionId="session-1" state="live" hasHost hasGym />);

    expect(trackBeforeNavigation).toHaveBeenCalledTimes(1);
  });

  it('counts a different session as its own landing', () => {
    render(<SessionInviteLandingTracker sessionId="session-1" state="live" hasHost hasGym />);
    render(<SessionInviteLandingTracker sessionId="session-2" state="ended" hasHost={false} hasGym={false} />);

    expect(trackBeforeNavigation).toHaveBeenCalledTimes(2);
  });

  it('renders nothing', () => {
    const { container } = render(
      <SessionInviteLandingTracker sessionId="session-1" state="not_found" hasHost={false} hasGym={false} />,
    );

    expect(container.innerHTML).toBe('');
  });
});
