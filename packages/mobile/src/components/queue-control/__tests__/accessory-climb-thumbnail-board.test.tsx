// @vitest-environment jsdom
// #5099 — the accessory bar's little board render is the first thing a climber
// sees after switching boards: the capsule, the "On the wall" strip and the iPad
// sidebar cell all go through it. A climb carried over from another board has to
// be drawn on that board, not on the selected one, where none of its holds exist.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardConfig } from '../../../providers/drawer-host-provider';

type ImageProps = { boardName?: string; layoutId?: number; sizeId?: number; setIds?: string; frames?: string };
const recorded = vi.hoisted(() => ({ images: [] as ImageProps[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: ImageProps) => {
    recorded.images.push(props);
    return createElement('div', { 'data-testid': 'board-image' });
  },
}));

// `lib/board-details` stays REAL — the whole point is which board's placements
// the thumbnail is built from.
const { AccessoryClimbThumbnail } = await import('../AccessoryClimbThumbnail');

const TWELVE_BY_TWELVE: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

beforeEach(() => {
  recorded.images = [];
});

describe('AccessoryClimbThumbnail board resolution (#5099)', () => {
  it('draws a Homewall climb on the Homewall while the selected board is the 12x12', () => {
    render(
      createElement(AccessoryClimbThumbnail, {
        climb: { frames: 'p1145r15', boardType: 'kilter', layoutId: 8, angle: 30 },
        boardConfig: TWELVE_BY_TWELVE,
      }),
    );

    expect(recorded.images.at(-1)?.layoutId).toBe(8);
    expect(recorded.images.at(-1)?.boardName).toBe('kilter');
  });

  it('keeps a climb from the selected board on the selected board', () => {
    render(
      createElement(AccessoryClimbThumbnail, {
        climb: { frames: 'p1145r15', boardType: 'kilter', layoutId: 1, angle: 40 },
        boardConfig: TWELVE_BY_TWELVE,
      }),
    );

    expect(recorded.images.at(-1)).toMatchObject({
      boardName: TWELVE_BY_TWELVE.boardName,
      layoutId: TWELVE_BY_TWELVE.layoutId,
      sizeId: TWELVE_BY_TWELVE.sizeId,
      setIds: TWELVE_BY_TWELVE.setIds,
    });
  });

  it('uses the passed board for a presence climb, which carries no board of its own', () => {
    // Board-presence climbs are, by construction, lit on the board the strip is
    // bound to — they only carry frames.
    render(
      createElement(AccessoryClimbThumbnail, {
        climb: { frames: 'p1145r15' },
        boardConfig: TWELVE_BY_TWELVE,
      }),
    );

    expect(recorded.images.at(-1)).toMatchObject({
      boardName: TWELVE_BY_TWELVE.boardName,
      layoutId: TWELVE_BY_TWELVE.layoutId,
      sizeId: TWELVE_BY_TWELVE.sizeId,
    });
  });

  it('renders nothing without a board', () => {
    const { container } = render(
      createElement(AccessoryClimbThumbnail, { climb: { frames: 'p1145r15' }, boardConfig: null }),
    );

    expect(container.querySelector('[data-testid="board-image"]')).toBeNull();
  });
});
