import { describe, it, expect } from 'vite-plus/test';
import { render } from '@testing-library/react';
import WoodsBoardRenderer from '../woods-renderer';
import type { HoldRenderData } from '../../board-renderer/types';

/**
 * Woods is the only board on web that ships dark-mode art, and the swap is done in CSS
 * because these pages are server-rendered with no theme cookie. That means both <image>
 * elements have to be in the markup with the classes the stylesheet keys off — assert the
 * pair here, since a CSS module can't be exercised in jsdom.
 */

const HOLDS: HoldRenderData[] = [{ id: 1, mirroredHoldId: 2, cx: 100, cy: 200, r: 20 }];

const renderBoard = (props: Partial<React.ComponentProps<typeof WoodsBoardRenderer>> = {}) =>
  render(
    <WoodsBoardRenderer
      holdsData={HOLDS}
      backgroundImage="woods-8x10-bg.png"
      boardWidth={720}
      boardHeight={1000}
      {...props}
    />,
  );

const artHrefs = (container: HTMLElement) =>
  [...container.querySelectorAll('image')].map((node) => ({
    href: node.getAttribute('href'),
    className: node.getAttribute('class'),
  }));

describe('WoodsBoardRenderer background art', () => {
  it('renders the light art and its dark sibling, each tagged for the CSS swap', () => {
    const { container } = renderBoard();
    const [light, dark] = artHrefs(container);

    expect(light.href).toBe('/images/woods/woods-8x10-bg.webp');
    expect(dark.href).toBe('/images/woods/woods-8x10-bg.dark.webp');
    expect(light.className).not.toBe(dark.className);
    expect(light.className).toBeTruthy();
    expect(dark.className).toBeTruthy();
  });

  it('keeps the pair on the thumbnail path', () => {
    const { container } = renderBoard({ backgroundImage: 'woods-12x12-bg.png', thumbnail: true });

    expect(artHrefs(container).map((art) => art.href)).toEqual([
      '/images/woods/thumbs/woods-12x12-bg.webp',
      '/images/woods/thumbs/woods-12x12-bg.dark.webp',
    ]);
  });
});
