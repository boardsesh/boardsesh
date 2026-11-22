import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';

/**
 * The board stage (A2): the LCP image moved out of the front door unchanged,
 * and the hold legend under it.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const flat = Object.entries(options)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(',');
      return `${key}(${flat})`;
    },
    locale: 'en-US',
  })),
}));

const ClimbBoardStage = (await import('../climb-board-stage')).default;
const HoldLegend = (await import('../hold-legend')).default;

const OVERLAY_URL = '/api/internal/board-render?variant=overlay';

async function renderStage(backgroundUrls: string[] = [], frames = 'p1r12p2r13p3r13p4r14p5r15') {
  const element = (
    <ClimbBoardStage
      backgroundUrls={backgroundUrls}
      overlayUrl={OVERLAY_URL}
      boardWidth={1080}
      boardHeight={1350}
      alt="Test Climb lit up"
    >
      <HoldLegend board="kilter" frames={frames} />
    </ClimbBoardStage>
  );
  return renderToString(<>{await resolveServerTree(element)}</>);
}

function imageTags(html: string): string[] {
  return html.match(/<img[^>]*>/g) ?? [];
}

describe('ClimbBoardStage', () => {
  it('renders the holds render as a high-priority image with its size reserved', async () => {
    const [overlay, ...rest] = imageTags(await renderStage());
    expect(rest).toHaveLength(0);
    expect(overlay).toContain(`src="${OVERLAY_URL.replaceAll('&', '&amp;')}"`);
    expect(overlay).toContain('alt="Test Climb lit up"');
    expect(overlay).toContain('width="1080"');
    expect(overlay).toContain('height="1350"');
    expect(overlay).toMatch(/fetchPriority="high"|fetchpriority="high"/);
    // The LCP image must never wait for a scroll.
    expect(overlay).not.toMatch(/loading=/);
  });

  it('stacks a light and a dark board photo under the holds on a board with dark art', async () => {
    const images = imageTags(await renderStage(['/images/woods/board.webp']));
    expect(images).toHaveLength(3);
    expect(images[0]).toContain('src="/images/woods/board.webp"');
    expect(images[1]).toContain('src="/images/woods/board.dark.webp"');
    expect(images[2]).toContain(`alt="Test Climb lit up"`);
    // Only the holds render is announced; the photo layers are decoration.
    expect(images.slice(0, 2).every((image) => image.includes('alt=""'))).toBe(true);
    expect(images.every((image) => /fetchPriority="high"|fetchpriority="high"/.test(image))).toBe(true);
  });

  it('puts the hold legend under the art', async () => {
    const html = await renderStage();
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('aria-label="frontDoor.legend.aria"'));
  });
});

describe('HoldLegend', () => {
  it('lists each role the climb uses, start to foot, with its count in bold', async () => {
    const html = await renderStage(undefined, 'p9r15p1r14p2r13p3r12p4r13');
    const items = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(([, item]) => item);
    expect(items).toHaveLength(4);
    expect(items[0]).toContain('frontDoor.legend.start(count=1,formattedCount=<b>1</b>)');
    expect(items[1]).toContain('frontDoor.legend.hand(count=2,formattedCount=<b>2</b>)');
    expect(items[2]).toContain('frontDoor.legend.finish(count=1,formattedCount=<b>1</b>)');
    expect(items[3]).toContain('frontDoor.legend.foot(count=1,formattedCount=<b>1</b>)');
  });

  it('draws each role as its own shape in its render colour, hidden from screen readers', async () => {
    const html = await renderStage(undefined, 'p1r12p2r13p3r14p4r15');
    const shapes = [...html.matchAll(/<svg[^>]*aria-hidden="true"[^>]*>(<[a-z]+)[^>]*fill="([^"]+)"/g)].map(
      ([, shape, fill]) => `${shape.slice(1)} ${fill}`,
    );
    expect(shapes).toEqual(['path #00FF00', 'circle #4DF5FD', 'rect #FF00FF', 'path #FFAA00']);
  });

  it('leaves out roles the climb does not use', async () => {
    const html = await renderStage(undefined, 'p1r12p2r14');
    expect(html).not.toContain('frontDoor.legend.hand');
    expect(html).not.toContain('frontDoor.legend.foot');
  });

  it('renders no list at all when nothing is lit', async () => {
    const html = await renderStage(undefined, '');
    expect(html).not.toContain('<ul');
  });
});
