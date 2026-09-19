import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { discoveryBoard } from '@/app/__test-helpers__/board-discovery-fixture';
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
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

describe('PopularBoardRail server HTML', () => {
  it('emits public named-board and gym links plus direct app actions without hydration', () => {
    const boards = Array.from({ length: 8 }, (_, index) =>
      discoveryBoard({
        uuid: `board-${index}`,
        slug: `physical-wall-${index}`,
        name: `Physical wall ${index}`,
      }),
    );
    const html = renderToString(<PopularBoardRail boards={boards} />);
    for (const board of boards) {
      expect(html).toContain(`href="/b/${board.slug}"`);
      expect(html).toContain(`href="${APP_URL}/b/${board.slug}/40/list"`);
      expect(html).toContain(board.name);
    }
    expect(html).toContain('href="/gym/northside-boulders"');
    expect(html).not.toContain('/kilter/original/');
  });

  it('renders no orphaned heading when discovery is empty or unavailable', () => {
    expect(renderToString(<PopularBoardRail boards={[]} />)).toBe('');
  });

  it('keeps board identity in HTML even when catalogue artwork cannot resolve', () => {
    const html = renderToString(<PopularBoardRail boards={[discoveryBoard({ layoutId: 999999 })]} />);
    expect(html).toContain('href="/b/northside-kilter"');
    expect(html).toContain('Training room Kilter');
  });
});
