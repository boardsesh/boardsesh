import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { cleanup, render } from '@testing-library/react';
import type { BoardImageDetails, Climb } from '@/app/lib/types';
import { V_GRADE_COLORS } from '@/app/lib/grade-colors';
import StaticClimbRow from '../static-climb-row';

/**
 * What the crawler actually reads. `renderToString` runs no effects, which is
 * precisely the server's situation: the reader's grade format lives in
 * IndexedDB and only resolves in an effect, so a row that waits for it ships
 * HTML with a Skeleton where the grade belongs — and the grade is the single
 * most-searched climb attribute. `showGradeWhileLoading` (climb-title.tsx) is
 * what closes that gap; these cases fail if it is dropped.
 */
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'ABC123',
    setter_username: 'setter_joe',
    name: 'Test Climb',
    description: '',
    frames: 'p1080r15',
    angle: 40,
    ascensionist_count: 12,
    difficulty: '6A+/V4',
    quality_average: '3',
    stars: 3,
    mirrored: false,
    ...overrides,
  } as Climb;
}

function makeBoardDetails(): BoardImageDetails {
  return {
    backgroundImagePaths: [],

    boardHeight: 100,
    boardWidth: 100,
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
  };
}

function rowHtml(climb: Climb = makeClimb()) {
  return renderToString(<StaticClimbRow climb={climb} boardDetails={makeBoardDetails()} pathname="/playlists/uuid" />);
}

describe('StaticClimbRow server HTML', () => {
  it('carries the climb grade, not a placeholder', () => {
    const html = rowHtml();
    expect(html).toContain('V4');
    expect(html).not.toContain('MuiSkeleton');
  });

  it('carries the name, the setter and the send count too', () => {
    const html = rowHtml();
    expect(html).toContain('Test Climb');
    expect(html).toContain('setter_joe');
    expect(html).toContain('12');
  });

  it('falls back to the raw difficulty when it has no V-grade to format', () => {
    const html = rowHtml(makeClimb({ difficulty: '6a' }));
    expect(html).toContain('6a');
    expect(html).not.toContain('MuiSkeleton');
  });
});

describe('StaticClimbRow as a card', () => {
  // `#FF5026` as a computed style reports it.
  const V4_RGB = `rgb(${[1, 3, 5].map((offset) => parseInt(V_GRADE_COLORS.V4.slice(offset, offset + 2), 16)).join(', ')})`;

  function cardHtml(props: { showSetter?: boolean; showAngle?: boolean } = {}) {
    return renderToString(
      <StaticClimbRow
        climb={makeClimb()}
        boardDetails={makeBoardDetails()}
        pathname="/setter/setter_joe"
        variant="card"
        {...props}
      />,
    );
  }

  /** The grade's element in a client render, where emotion's styles are live to read back. */
  function gradeElement(variant: 'list' | 'card') {
    const { getByText } = render(
      <StaticClimbRow climb={makeClimb()} boardDetails={makeBoardDetails()} pathname="/setter/x" variant={variant} />,
    );
    return getByText('V4+');
  }

  afterEach(cleanup);

  it('puts the grade on a chip in its grade colour, still in the server HTML', () => {
    const html = cardHtml();
    expect(html).toContain('>V4+</span>');
    expect(html).not.toContain('MuiSkeleton');

    expect(getComputedStyle(gradeElement('card')).backgroundColor).toBe(V4_RGB);
  });

  it('keeps the plain row drawing the grade as coloured text, with no chip', () => {
    const style = getComputedStyle(gradeElement('list'));

    expect(style.backgroundColor).not.toBe(V4_RGB);
    expect(style.color).not.toBe('');
  });

  it("drops the setter's name on a page that is already theirs, and can name the angle instead", () => {
    const html = cardHtml({ showSetter: false, showAngle: true });

    expect(html).not.toContain('setter_joe');
    expect(html).toContain('40°');
  });

  it('keeps one anchor per row', () => {
    expect(cardHtml().match(/<a\s/g) ?? []).toHaveLength(1);
  });
});
