// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BetaLink } from '@/app/lib/api-wrappers/sync-api-types';
import BoardseshBetaList from '../boardsesh-beta-list';
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
  it.each(['drawer', 'profile'] as const)('keeps a valid external URL without a thumbnail on %s', (source) => {
    render(<BoardseshBetaCard link={{ ...betaLink, thumbnail: null }} source={source} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe(betaLink.link);
    expect(screen.getByRole('link').textContent).not.toBe('');
  });
  it('hides a home gallery tile without a frame', () => {
    const { container } = render(<BoardseshBetaCard link={{ ...betaLink, thumbnail: null }} source="home" />);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('hides a failed home gallery thumbnail', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
    render(<BoardseshBetaCard link={betaLink} source="home" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it.each(['drawer', 'profile'] as const)('keeps thumbnail-free videos in a %s collection', (source) => {
    render(<BoardseshBetaList links={[{ ...betaLink, thumbnail: null }]} isLoading={false} source={source} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe(betaLink.link);
  });
});

describe('BoardseshBetaList grid layout', () => {
  it('keeps the rail as the default layout for other callers', () => {
    const { container } = render(<BoardseshBetaList links={[betaLink]} isLoading={false} source="profile" />);
    expect(container.querySelector('ul')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe(betaLink.link);
  });

  it('lists each video as one card: handle, platform and a watch label in the link', () => {
    render(<BoardseshBetaList links={[betaLink]} isLoading={false} source="drawer" layout="grid" />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(betaLink.link);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('ugc nofollow noopener noreferrer');
    expect(link.textContent).toContain('@climber');
    expect(link.textContent).toContain('Instagram');
    expect(link.textContent).toContain('betaVideos.watch');
    // The thumbnail is decoration; the card's text names the link.
    expect(link.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('shows a play tile, not a platform logo, for a video with no thumbnail', () => {
    render(
      <BoardseshBetaList links={[{ ...betaLink, thumbnail: null }]} isLoading={false} source="drawer" layout="grid" />,
    );
    const link = screen.getByRole('link');
    expect(link.querySelector('img')).toBeNull();
    expect(link.querySelector('[data-testid="PlayArrowRoundedIcon"]')).not.toBeNull();
    expect(link.querySelector('[data-testid="InstagramIcon"]')).toBeNull();
    expect(link.textContent).toContain('@climber');
  });

  it('turns a thumbnail that fails to load into the play tile and keeps the card', () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
    render(<BoardseshBetaList links={[betaLink]} isLoading={false} source="drawer" layout="grid" />);
    const thumbnail = screen.getByRole('link').querySelector('img');
    if (!thumbnail) throw new Error('the card rendered no thumbnail');
    fireEvent.error(thumbnail);
    expect(screen.getByRole('link').querySelector('img')).toBeNull();
    expect(screen.getByRole('link').querySelector('[data-testid="PlayArrowRoundedIcon"]')).not.toBeNull();
  });

  it('names the platform as the headline when the filmer is unknown', () => {
    render(
      <BoardseshBetaList
        links={[{ ...betaLink, foreign_username: null, link: 'https://www.tiktok.com/@x/video/1' }]}
        isLoading={false}
        source="drawer"
        layout="grid"
      />,
    );
    const link = screen.getByRole('link');
    expect(link.textContent).toBe('TikTokbetaVideos.watch');
  });

  it('keeps every video in the HTML but folds all past the first six behind "Show all" from md', () => {
    const links = Array.from({ length: 8 }, (_, index) => ({ ...betaLink, link: `${betaLink.link}${index}` }));
    const { container } = render(<BoardseshBetaList links={links} isLoading={false} source="drawer" layout="grid" />);
    expect(screen.getAllByRole('link')).toHaveLength(8);
    expect(container.querySelectorAll('li[data-beyond-preview]')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'betaVideos.showAll' }));
    expect(container.querySelector('ul')?.getAttribute('data-expanded')).toBe('true');
    expect(screen.queryByRole('button')).toBeNull();
    // The button is gone, so focus moves to the first card it revealed, not <body>.
    expect(document.activeElement).toBe(screen.getAllByRole('link')[6]);
  });

  it('offers no "Show all" when six or fewer videos fit', () => {
    render(<BoardseshBetaList links={[betaLink]} isLoading={false} source="drawer" layout="grid" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('records the click with the platform and placement', async () => {
    const { track } = await import('@/app/lib/analytics');
    render(<BoardseshBetaList links={[betaLink]} isLoading={false} source="drawer" layout="grid" />);
    fireEvent.click(screen.getByRole('link'));
    expect(track).toHaveBeenCalledWith('Beta Video Link Clicked', {
      platform: 'Instagram',
      climbUuid: 'climb-1',
      source: 'drawer',
      foreignUsername: 'climber',
    });
  });
});
