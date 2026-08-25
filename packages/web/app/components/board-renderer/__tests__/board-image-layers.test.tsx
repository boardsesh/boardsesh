// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';
import type { BoardDetails } from '@/app/lib/types';
import BoardImageLayers from '../board-image-layers';

vi.mock('../util', () => ({
  // Mirrors the real split: an ordinary board gets one composite with the photo baked in,
  // a themed board gets static photo layers plus a background-less overlay.
  buildBoardArtLayers: (bd: BoardDetails, frames: string | undefined, thumbnail?: boolean) => {
    const overlay = frames ? `/api/internal/board-render?frames=${frames}${thumbnail ? '&thumbnail=1' : ''}` : null;
    if (bd.board_name !== 'woods') {
      return { backgroundUrls: [], overlayUrl: overlay ? `${overlay}&include_background=1` : null };
    }
    return {
      backgroundUrls: Object.keys(bd.images_to_holds).map((image) =>
        `/images/${bd.board_name}/${image}`.replace(/\.png$/, '.webp'),
      ),
      overlayUrl: overlay,
    };
  },
  // Mirrors the real .png -> .webp rewrite: toDarkArtUrl keys off the .webp extension, so a
  // mock that skipped it would make the dark URL identical to the light one and the paired
  // assertions below would pass without exercising anything.
  getImageUrl: (imageUrl: string, board: string) => `/images/${board}/${imageUrl}`.replace(/\.png$/, '.webp'),
  buildOverlayUrl: vi.fn(
    (_bd: BoardDetails, frames: string, thumbnail?: boolean, colorScheme?: 'light' | 'dark') =>
      `/api/internal/board-render?frames=${frames}${thumbnail ? '&thumbnail=1' : ''}&include_background=1` +
      (colorScheme === 'dark' ? '&color_scheme=dark' : ''),
  ),
  // Woods is the real member of this set; the fixtures below are Kilter, which
  // deliberately renders one image per layer so no other board pays for the swap.
  hasDarkBoardArt: (board: string) => board === 'woods',
  toDarkArtUrl: (url: string) => url.replace(/\.webp$/, '.dark.webp'),
}));

const mockBoardDetails: BoardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 7,
  set_ids: [1, 20],
  images_to_holds: { 'product_sizes_layouts_sets/36-1.png': [] },
  holdsData: [],
  edge_left: 0,
  edge_right: 144,
  edge_bottom: 0,
  edge_top: 180,
  boardWidth: 1080,
  boardHeight: 1350,
};

describe('BoardImageLayers', () => {
  it('renders single composited image when frames are provided', () => {
    const { container } = render(
      <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42p2r43" mirrored={false} />,
    );

    const images = container.querySelectorAll('img');
    // Single composited image (background + overlay baked together)
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toContain('frames=p1r42p2r43');
  });

  it('renders background images when no frames are provided', () => {
    const { container } = render(<BoardImageLayers boardDetails={mockBoardDetails} mirrored={false} />);

    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('/images/kilter/product_sizes_layouts_sets/36-1.webp');
  });

  it('renders multiple background images when no frames and board has multiple sets', () => {
    const multiSetBoard: BoardDetails = {
      ...mockBoardDetails,
      images_to_holds: {
        'product_sizes_layouts_sets/36-1.png': [],
        'product_sizes_layouts_sets/37-1.png': [],
      },
    };

    const { container } = render(<BoardImageLayers boardDetails={multiSetBoard} mirrored={false} />);

    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('renders single composited image even with multiple background sets', () => {
    const multiSetBoard: BoardDetails = {
      ...mockBoardDetails,
      images_to_holds: {
        'product_sizes_layouts_sets/36-1.png': [],
        'product_sizes_layouts_sets/37-1.png': [],
      },
    };

    const { container } = render(<BoardImageLayers boardDetails={multiSetBoard} frames="p1r42" mirrored={false} />);

    // Only 1 composited image, no separate backgrounds
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('applies scaleX(-1) transform when mirrored', () => {
    const { container } = render(
      <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored style={{ width: '100%' }} />,
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.transform).toBe('scaleX(-1)');
  });

  it('does not apply transform when not mirrored', () => {
    const { container } = render(
      <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} style={{ width: '100%' }} />,
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.transform).toBeFalsy();
  });

  it('passes the thumbnail flag through to the art URLs', () => {
    const { container } = render(
      <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} thumbnail />,
    );

    expect(container.querySelector('img')?.getAttribute('src')).toContain('thumbnail=1');
  });

  it('uses object-fit contain when contain prop is set', () => {
    const { container } = render(
      <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} contain />,
    );

    const images = container.querySelectorAll('img');
    images.forEach((img) => {
      expect(img.style.objectFit).toBe('contain');
    });
  });

  it('uses object-fit contain when thumbnail prop is set', () => {
    const { container } = render(
      <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} thumbnail />,
    );

    const images = container.querySelectorAll('img');
    images.forEach((img) => {
      expect(img.style.objectFit).toBe('contain');
    });
  });

  it('uses thumbnail dimensions for img width/height when thumbnail is set', () => {
    const { container } = render(
      <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} thumbnail />,
    );

    const img = container.querySelector('img')!;
    // THUMBNAIL_WIDTH = 200, height = round(200 * 1350 / 1080) = 250
    expect(img.getAttribute('width')).toBe('200');
    expect(img.getAttribute('height')).toBe('250');
  });

  it('uses full board dimensions for img width/height when not thumbnail', () => {
    const { container } = render(<BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} />);

    const img = container.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('1080');
    expect(img.getAttribute('height')).toBe('1350');
  });

  describe('loading attribute', () => {
    it('lazy on thumbnails without fetchPriority=high (climb-list use case)', () => {
      const { container } = render(
        <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} thumbnail />,
      );
      expect(container.querySelector('img')!.getAttribute('loading')).toBe('lazy');
    });

    it('eager on thumbnails when fetchPriority=high (LCP thumbnail)', () => {
      const { container } = render(
        <BoardImageLayers
          boardDetails={mockBoardDetails}
          frames="p1r42"
          mirrored={false}
          thumbnail
          fetchPriority="high"
        />,
      );
      expect(container.querySelector('img')!.getAttribute('loading')).toBeNull();
    });

    it('eager on non-thumbnail (full-board) renders regardless of fetchPriority', () => {
      // climb-card-cover and swipe-board-carousel render full-size without
      // fetchPriority and are typically the in-viewport LCP target.
      const { container } = render(
        <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} />,
      );
      expect(container.querySelector('img')!.getAttribute('loading')).toBeNull();
    });

    it('eager on non-thumbnail background-only renders', () => {
      const { container } = render(<BoardImageLayers boardDetails={mockBoardDetails} mirrored={false} />);
      container.querySelectorAll('img').forEach((img) => {
        expect(img.getAttribute('loading')).toBeNull();
      });
    });

    it('first background image is eager when thumbnail + fetchPriority=high', () => {
      const { container } = render(
        <BoardImageLayers boardDetails={mockBoardDetails} mirrored={false} thumbnail fetchPriority="high" />,
      );
      const imgs = container.querySelectorAll('img');
      expect(imgs[0].getAttribute('loading')).toBeNull();
      // Subsequent background layers stay lazy.
      for (let i = 1; i < imgs.length; i++) {
        expect(imgs[i].getAttribute('loading')).toBe('lazy');
      }
    });
  });

  describe('boards that ship dark art', () => {
    // Woods art is hold sprites on an opaque white ground, so it has a `.dark.webp` sibling
    // and both variants go into the page for CSS to choose between — the server is rendering
    // these pages and cannot know the reader's theme.
    const woodsBoardDetails: BoardDetails = {
      ...mockBoardDetails,
      board_name: 'woods',
      images_to_holds: { 'woods-8x10-bg.png': [] },
    };

    const imageSources = (container: HTMLElement) =>
      [...container.querySelectorAll('img')].map((img) => ({
        src: img.getAttribute('src') ?? '',
        className: img.getAttribute('class') ?? '',
      }));

    it('themes the static photo and still renders the climb overlay exactly once', () => {
      // The point of the split: a themed board must not cost a second WASM + sharp render
      // per card. Two photo layers (static files every card on the page shares) and one
      // overlay — never two overlays.
      const { container } = render(
        <BoardImageLayers boardDetails={woodsBoardDetails} frames="p1r42" mirrored={false} />,
      );

      const images = imageSources(container);
      expect(images).toHaveLength(3);

      const [light, dark, overlay] = images;
      expect(light.src).toBe('/images/woods/woods-8x10-bg.webp');
      expect(dark.src).toBe('/images/woods/woods-8x10-bg.dark.webp');
      expect(light.className).not.toBe(dark.className);

      expect(overlay.src).toContain('board-render');
      expect(overlay.src).not.toContain('include_background=1');
      expect(overlay.className).toBe('');
      expect(images.filter((image) => image.src.includes('board-render'))).toHaveLength(1);
    });

    it('pairs the background layers when there is no climb to overlay', () => {
      const { container } = render(<BoardImageLayers boardDetails={woodsBoardDetails} mirrored={false} />);

      expect(imageSources(container).map((image) => image.src)).toEqual([
        '/images/woods/woods-8x10-bg.webp',
        '/images/woods/woods-8x10-bg.dark.webp',
      ]);
    });

    it('leaves the paired layers without an inline display, so the stylesheet can hide one', () => {
      // An inline `display: block` beats the class and both variants would paint on top of
      // each other. Boards without dark art keep the inline value.
      const { container } = render(
        <BoardImageLayers boardDetails={woodsBoardDetails} frames="p1r42" mirrored={false} />,
      );
      for (const img of container.querySelectorAll('img')) {
        expect(img.style.display).toBe('');
      }

      const { container: kilter } = render(
        <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} />,
      );
      expect(kilter.querySelector('img')?.style.display).toBe('block');
    });

    it('keeps the single baked composite for every other board', () => {
      const { container } = render(
        <BoardImageLayers boardDetails={mockBoardDetails} frames="p1r42" mirrored={false} />,
      );

      const images = imageSources(container);
      expect(images).toHaveLength(1);
      expect(images[0].src).toContain('include_background=1');
      expect(images[0].className).toBe('');
    });
  });
});
