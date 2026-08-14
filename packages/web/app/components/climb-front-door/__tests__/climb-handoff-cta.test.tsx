import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import { APP_URL } from '@/app/lib/app-origin';

/**
 * The hand-off CTA's telemetry contract.
 *
 * `Climb Handoff Clicked` is the front door's only measurement of the funnel
 * this whole surface exists to feed, and it fires on a click that immediately
 * destroys the page. posthog-js-lite batches (20 events / 10s, no `pagehide`
 * handler, no `sendBeacon`), so a plain `track()` here would be queued into a
 * document that no longer exists — PostHog would show ~zero hand-offs against a
 * healthy app-side `Board Route Handoff`, which reads as a broken hand-off
 * rather than a broken meter. These tests pin the delivery path, not just the
 * event name.
 */

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  trackBeforeNavigation: vi.fn(async () => {}),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: mocks.track,
  trackBeforeNavigation: mocks.trackBeforeNavigation,
}));

const ClimbHandoffCta = (await import('../climb-handoff-cta')).default;

const PATHNAME = '/kilter/original/12x12-square/screw_bolt/40/view/CLIMB1';
const EXPECTED_HREF = `${APP_URL}${PATHNAME}`;

const originalLocation = window.location;
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    value: { ...originalLocation, assign, href: 'https://boardsesh.com' + PATHNAME },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
});

function renderCta() {
  return render(
    <ClimbHandoffCta
      pathname={PATHNAME}
      label="Climb this"
      ariaLabel="Climb this"
      surface="climb_front_door"
      tree="config-tuple"
      boardName="kilter"
      layoutId={1}
      angle={40}
      climbUuid="CLIMB1"
      locale="en-US"
    />,
  );
}

function cta() {
  return screen.getByRole('link', { name: 'Climb this' });
}

describe('ClimbHandoffCta', () => {
  it('is a real anchor at the app origin, so it works with JS off and to a crawler', () => {
    renderCta();

    expect(cta().getAttribute('href')).toBe(EXPECTED_HREF);
  });

  it('holds the navigation until the event is flushed, then goes', async () => {
    let releaseFlush: () => void = () => {};
    mocks.trackBeforeNavigation.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );
    renderCta();

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    cta().dispatchEvent(click);

    // The browser's own navigation is cancelled — otherwise the flush below
    // would be racing a document teardown, which is the bug this replaces.
    expect(click.defaultPrevented).toBe(true);
    expect(assign).not.toHaveBeenCalled();

    expect(mocks.trackBeforeNavigation).toHaveBeenCalledWith(
      'Climb Handoff Clicked',
      expect.objectContaining({
        environment: 'production-web',
        surface: 'climb_front_door',
        tree: 'config-tuple',
        boardName: 'kilter',
        layoutId: 1,
        angle: 40,
        climbUuid: 'CLIMB1',
        locale: 'en-US',
        campaign: 'front_door',
      }),
    );
    // The batching `track()` is not what carries this event off the page.
    expect(mocks.track).not.toHaveBeenCalled();

    releaseFlush();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(EXPECTED_HREF));
  });

  it('navigates anyway when the flush never resolves cleanly', async () => {
    mocks.trackBeforeNavigation.mockRejectedValueOnce(new Error('flush blew up'));
    renderCta();

    cta().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(EXPECTED_HREF));
  });

  it('leaves a modified click to the browser — that document survives to flush', async () => {
    renderCta();

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    cta().dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(mocks.trackBeforeNavigation).not.toHaveBeenCalled();
    expect(mocks.track).toHaveBeenCalledWith(
      'Climb Handoff Clicked',
      expect.objectContaining({ campaign: 'front_door' }),
    );
  });
});
