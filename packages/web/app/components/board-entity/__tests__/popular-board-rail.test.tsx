// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
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

/**
 * Kilter layout 1 carries two "12 x 12" squares — id 10 ("with kickboard") and
 * id 27 ("without kickboard") — that both *name*-slug to `12x12-square`. The
 * rail must address the exact wall, so the href comes from #4417's id-first
 * `popularConfigListUrl`, not the name-based `constructClimbListWithSlugs` the
 * issue text named. Slugging from names would send a size-27 climber to size
 * 10's board — a different physical wall.
 */
function makeConfig(overrides: Partial<PopularBoardConfig> = {}): PopularBoardConfig {
  return {
    boardType: 'kilter',
    layoutId: 1,
    layoutName: 'Original',
    sizeId: 10,
    sizeName: '12 x 12 Square',
    sizeDescription: 'With kickboard',
    setIds: [1, 20],
    setNames: ['Bolt Ons', 'Screw Ons'],
    climbCount: 500,
    totalAscents: 5000,
    boardCount: 12,
    displayName: 'Kilter Original 12x12',
    ...overrides,
  };
}

function firstHref(config: PopularBoardConfig): string | null {
  render(<PopularBoardRail configs={[config]} />);
  return screen.getAllByRole('link')[0].getAttribute('href');
}

describe('PopularBoardRail hrefs', () => {
  it('emits the qualified size slug for the shadowed Kilter size', () => {
    expect(firstHref(makeConfig({ sizeId: 27 }))).toBe(
      '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/list',
    );
  });

  it('leaves the size that owns the bare slug on it', () => {
    expect(firstHref(makeConfig({ sizeId: 10 }))).toBe('/kilter/original/12x12-square/screw_bolt/40/list');
  });

  it('takes the angle from getDefaultAngleForBoard, not a literal in the rail', () => {
    // Every board type happens to default to 40 in board-config-for-playlist
    // today, so this can't distinguish by value — it pins the wiring, and
    // stays honest on the day one of them moves off 40.
    const href = firstHref(makeConfig());
    expect(href?.endsWith(`/${getDefaultAngleForBoard('kilter')}/list`)).toBe(true);
  });

  it('skips a config the board tables cannot resolve rather than crashing the rail', () => {
    render(
      <PopularBoardRail
        configs={[makeConfig(), makeConfig({ boardType: 'kilter', layoutId: 999_999, sizeId: 999_999, setIds: [1] })]}
      />,
    );
    // Two configs in, one resolvable board out — the rail still renders.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
