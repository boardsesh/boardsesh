import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { APP_URL } from '@/app/lib/app-origin';

/**
 * The playlist page's hand-off had no event at all. It fires on a click that
 * replaces the page with app.boardsesh.com, so like the climb page's hand-off it
 * must hold the navigation for the flush, or the event dies with the page.
 */

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  trackBeforeNavigation: vi.fn(async () => {}),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: mocks.track,
  trackBeforeNavigation: mocks.trackBeforeNavigation,
}));

const PlaylistHandoffButton = (await import('../playlist-handoff-button')).default;

const HREF = `${APP_URL}/discover/playlist-uuid-1`;
const originalLocation = window.location;
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    // All the click path reads: where this page is, and how to leave it.
    value: { origin: 'https://www.boardsesh.com', assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
});

function renderButton(overrides: Partial<React.ComponentProps<typeof PlaylistHandoffButton>> = {}) {
  render(
    <PlaylistHandoffButton
      playlistUuid="playlist-uuid-1"
      boardType="kilter"
      layoutId={1}
      isPublic
      locale="en-US"
      {...overrides}
    >
      Open in your browser
    </PlaylistHandoffButton>,
  );
  return screen.getByRole('link', { name: 'Open in your browser' });
}

describe('PlaylistHandoffButton', () => {
  it('is a real link to the playlist on the app origin', () => {
    expect(renderButton().getAttribute('href')).toBe(HREF);
  });

  it('is a text button whatever it looks like, so a phone keeps one filled button: the store', () => {
    const link = renderButton({ ctaName: 'handoff' });

    expect(link.classList.contains('MuiButton-text')).toBe(true);
    expect(link.classList.contains('MuiButton-contained')).toBe(false);
    expect(link.getAttribute('data-cta')).toBe('handoff');
  });

  it('sends Playlist Handoff Clicked, then navigates once the flush settles', async () => {
    const link = renderButton();
    fireEvent.click(link);

    expect(mocks.trackBeforeNavigation).toHaveBeenCalledExactlyOnceWith('Playlist Handoff Clicked', {
      environment: 'production-web',
      surface: 'playlist_front_door',
      boardName: 'kilter',
      layoutId: 1,
      isPublic: true,
      playlistUuid: 'playlist-uuid-1',
      locale: 'en-US',
      campaign: 'front_door',
    });
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(HREF));
  });

  it('still navigates when the flush fails', async () => {
    mocks.trackBeforeNavigation.mockRejectedValueOnce(new Error('blocked'));
    fireEvent.click(renderButton());
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(HREF));
  });

  it('leaves a private playlist’s id out and sends null for a circuit with no layout', () => {
    fireEvent.click(renderButton({ isPublic: false, layoutId: null }));

    const [, properties] = mocks.trackBeforeNavigation.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(properties).toMatchObject({ isPublic: false, layoutId: null });
    expect(properties.playlistUuid).toBeUndefined();
  });

  it('lets a modified click open its new tab untouched, tracking it on the normal batch', () => {
    fireEvent.click(renderButton(), { metaKey: true });

    expect(mocks.track).toHaveBeenCalledWith(
      'Playlist Handoff Clicked',
      expect.objectContaining({ surface: 'playlist_front_door' }),
    );
    expect(mocks.trackBeforeNavigation).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
