// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import BoardseshBetaCard from '../boardsesh-beta-card';

vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const betaLink: BetaLink = {
  climb_uuid: 'climb-1',
  link: 'https://www.instagram.com/reel/example/',
  foreign_username: 'climber',
  angle: 40,
  thumbnail: 'https://example.com/thumbnail.jpg',
  is_listed: true,
  created_at: '',
  tick_uuid: null,
  board_id: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BoardseshBetaCard thumbnail fallback', () => {
  it('keeps a thumbnail that is still loading', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
    render(<BoardseshBetaCard link={betaLink} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe(betaLink.thumbnail);
  });

  it('keeps an image that loaded before hydration', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(280);
    render(<BoardseshBetaCard link={betaLink} />);
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('replaces a thumbnail that failed before hydration without losing its link', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
    render(<BoardseshBetaCard link={betaLink} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe(betaLink.link);
  });

  it('replaces a thumbnail that fails after hydration', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
    render(<BoardseshBetaCard link={betaLink} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe(betaLink.link);
  });
});
