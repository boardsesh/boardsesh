import { describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import GymPopularClimbPreview, { type GymPopularPreviewBoard } from '../gym-popular-climb-preview';
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
const board = {
  uuid: 'wall-id',
  slug: 'gym-kilter',
  name: 'Gym Kilter',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
  currentClimb: { uuid: 'presence', name: 'Live selection', frames: 'p2r14', angle: 40 },
  popularClimb: { uuid: 'popular', name: 'Local favourite', frames: 'p1r12', angle: 35 },
} as unknown as GymPopularPreviewBoard;
const preview = (selected: GymPopularPreviewBoard) =>
  render(
    <GymPopularClimbPreview
      board={selected}
      heading="Most logged climb at this wall"
      description="From public sends and flashes logged here."
    />,
  );
describe('optional local gym climb preview', () => {
  it('lights the actual local winner and links its physical board and logged angle', () => {
    preview(board);
    expect(
      new URL(screen.getByRole('img').getAttribute('src')!, 'https://example.com').searchParams.get('frames'),
    ).toBe('p1r12');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/b/gym-kilter/35/view/local-favourite-popular');
  });
  it('omits missing local data rather than presenting presence as popularity', () => {
    preview({ ...board, popularClimb: null });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('omits failed art while the surrounding gym links remain available', () => {
    preview(board);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
