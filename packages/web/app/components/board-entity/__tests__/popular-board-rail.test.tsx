// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { discoveryBoard } from '@/app/__test-helpers__/board-discovery-fixture';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { APP_URL } from '@/app/lib/app-origin';
import PopularBoardRail from '../popular-board-rail';

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/app/components/board-renderer/board-renderer', () => ({ default: () => <div data-testid="board-art" /> }));

const gymAnchors = () =>
  screen.getAllByRole('link').filter((anchor) => anchor.getAttribute('href')?.startsWith('/gym/'));

describe('PopularBoardRail physical identity', () => {
  it('links the board name and app action to the same named installation', () => {
    render(<PopularBoardRail boards={[discoveryBoard()]} />);
    expect(screen.getByRole('link', { name: 'Training room Kilter' }).getAttribute('href')).toBe('/b/northside-kilter');
    expect(screen.getByRole('link', { name: 'Open this board' }).getAttribute('href')).toBe(
      `${APP_URL}/b/northside-kilter/40/list`,
    );
    expect(screen.getByRole('link', { name: 'Northside Boulders' }).getAttribute('href')).toBe(
      '/gym/northside-boulders',
    );
    expect(screen.getByText('Sydney')).toBeTruthy();
    expect(screen.getByText('12 climbers')).toBeTruthy();
    expect(screen.queryByText(/million|sends$/)).toBeNull();
  });

  it('preserves distinct UUID/slug identities even with exactly the same layout', () => {
    render(
      <PopularBoardRail
        boards={[
          discoveryBoard(),
          discoveryBoard({ uuid: 'board-two', slug: 'southside-kilter', name: 'Southside Kilter' }),
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Southside Kilter' }).getAttribute('href')).toBe('/b/southside-kilter');
    expect(screen.getAllByRole('link', { name: 'Open this board' }).map((link) => link.getAttribute('href'))).toEqual([
      `${APP_URL}/b/northside-kilter/40/list`,
      `${APP_URL}/b/southside-kilter/40/list`,
    ]);
  });

  it('retains a named board when its artwork is unsupported', () => {
    render(<PopularBoardRail boards={[discoveryBoard({ boardType: 'future-board', layoutId: 99999 })]} />);
    expect(screen.getByRole('link', { name: 'Training room Kilter' })).toBeTruthy();
    expect(screen.queryByTestId('board-art')).toBeNull();
    expect(screen.getByRole('img', { name: 'Board preview: Training room Kilter' })).toBeTruthy();
  });

  it('labels the selected snapshot and uses its angle without claiming a live feed', () => {
    render(
      <PopularBoardRail
        boards={[
          discoveryBoard({
            currentClimb: { uuid: 'climb-one', name: 'Night shift', frames: 'p100r42', angle: 35 },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Kilter · 35°')).toBeTruthy();
    expect(screen.getByText('Selected climb: Night shift')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open this board' }).getAttribute('href')).toBe(
      `${APP_URL}/b/northside-kilter/35/list`,
    );
    expect(screen.getByText(/Previews are snapshots, not live updates/)).toBeTruthy();
  });

  it('does not invent activity or selected climbs for a quiet board', () => {
    render(<PopularBoardRail boards={[discoveryBoard({ uniqueClimbers: 0 })]} />);
    expect(screen.queryByText(/0 climbers|Selected climb:/)).toBeNull();
  });

  it('says the location instead of repeating a board named after its own gym', () => {
    render(<PopularBoardRail boards={[discoveryBoard({ name: 'Northside Boulders' })]} />);
    // Still exactly one /gym/ anchor per card, and the location is said once.
    expect(gymAnchors().map((anchor) => anchor.textContent)).toEqual(['Sydney']);
    expect(gymAnchors()[0].getAttribute('href')).toBe('/gym/northside-boulders');
    expect(screen.getAllByText('Sydney')).toHaveLength(1);
  });

  it('drops the location line when board, gym and location are all the same name', () => {
    render(
      <PopularBoardRail
        boards={[discoveryBoard({ name: 'Northside Boulders', locationName: 'Northside Boulders' })]}
      />,
    );
    expect(gymAnchors().map((anchor) => anchor.textContent)).toEqual(['Northside Boulders']);
    expect(screen.getAllByText('Northside Boulders').filter((node) => node.tagName === 'P')).toHaveLength(0);
  });

  it('falls back to the gym name when a self-named board has no location', () => {
    render(<PopularBoardRail boards={[discoveryBoard({ name: 'Northside Boulders', locationName: null })]} />);
    expect(gymAnchors().map((anchor) => anchor.textContent)).toEqual(['Northside Boulders']);
    expect(gymAnchors()[0].getAttribute('href')).toBe('/gym/northside-boulders');
  });
});
