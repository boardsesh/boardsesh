import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import {
  FRONT_DOOR_MAX_INDEXABLE_PAGE,
  FRONT_DOOR_MAX_PAGE,
  FRONT_DOOR_PAGE_SIZE,
  frontDoorPagePath,
  isFrontDoorPageOutOfRange,
  isIndexableFrontDoorPage,
  parseFrontDoorPage,
} from '@/app/lib/seo/list-page-robots';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import type { BoardDetails } from '@/app/lib/types';

/**
 * The `/list` front door's `?page` contract, which both trees' pages consume.
 *
 * The per-page metadata assertions live next to each page
 * (`list/__tests__/page-metadata.test.tsx` and its `/b` twin); this file pins
 * the shared rules those two agree on, so a change to one page can't quietly
 * diverge from the other.
 */

const BASE = '/kilter/original/12x12-square/screw_bolt/40/list';

describe('front door pagination contract', () => {
  it('serves a page size that meets the ≥50-crawlable-links bar', () => {
    expect(FRONT_DOOR_PAGE_SIZE).toBeGreaterThanOrEqual(50);
  });

  it('treats a missing, empty or nonsense ?page as page 1', () => {
    expect(parseFrontDoorPage(undefined)).toBe(1);
    expect(parseFrontDoorPage('')).toBe(1);
    expect(parseFrontDoorPage('banana')).toBe(1);
    expect(parseFrontDoorPage('0')).toBe(1);
    expect(parseFrontDoorPage('-4')).toBe(1);
  });

  it('reads a repeated ?page=a&page=b as the first value', () => {
    expect(parseFrontDoorPage(['3', '9'])).toBe(3);
  });

  it('canonicalises ?page=1 onto the bare path — same page, one URL', () => {
    expect(frontDoorPagePath(BASE, 1)).toBe(BASE);
    expect(frontDoorPagePath(BASE, 2)).toBe(`${BASE}?page=2`);
  });

  it('keeps pages 1..10 indexable and drops out beyond', () => {
    for (let page = 1; page <= FRONT_DOOR_MAX_INDEXABLE_PAGE; page += 1) {
      expect(isIndexableFrontDoorPage(page)).toBe(true);
    }
    expect(isIndexableFrontDoorPage(FRONT_DOOR_MAX_INDEXABLE_PAGE + 1)).toBe(false);
    expect(isIndexableFrontDoorPage(500)).toBe(false);
  });

  it('clamps ?page above the hard ceiling instead of turning it into an unbounded offset', () => {
    // `fetchFrontDoorListPage` derives its OFFSET straight from this number, so
    // an unclamped `?page` is an unbounded `OFFSET` over the climb/stats join.
    expect(FRONT_DOOR_MAX_PAGE).toBeGreaterThan(FRONT_DOOR_MAX_INDEXABLE_PAGE);
    expect(parseFrontDoorPage(String(FRONT_DOOR_MAX_PAGE))).toBe(FRONT_DOOR_MAX_PAGE);
    expect(parseFrontDoorPage('5000')).toBe(FRONT_DOOR_MAX_PAGE);
    expect(parseFrontDoorPage('999999999')).toBe(FRONT_DOOR_MAX_PAGE);
  });

  it('reports anything past the hard ceiling as out of range, so the pages can 404 it', () => {
    expect(isFrontDoorPageOutOfRange(undefined)).toBe(false);
    expect(isFrontDoorPageOutOfRange('banana')).toBe(false);
    expect(isFrontDoorPageOutOfRange('1')).toBe(false);
    expect(isFrontDoorPageOutOfRange(String(FRONT_DOOR_MAX_PAGE))).toBe(false);
    expect(isFrontDoorPageOutOfRange(String(FRONT_DOOR_MAX_PAGE + 1))).toBe(true);
    expect(isFrontDoorPageOutOfRange('5000')).toBe(true);
    expect(isFrontDoorPageOutOfRange(['5000', '2'])).toBe(true);
  });
});

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, rel, children }: { href: string; rel?: string; children: React.ReactNode }) => (
    <a href={href} rel={rel}>
      {children}
    </a>
  ),
}));

// Neither is what this block asserts, and both would drag client-side
// providers into a node render.
vi.mock('@/app/components/climb-list/static-climb-list', () => ({ default: () => null }));
vi.mock('@/app/components/climb-front-door/climb-handoff-cta', () => ({ default: () => null }));

const StaticListFrontDoor = (await import('@/app/components/climb-front-door/static-list-front-door')).default;

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
} as unknown as BoardDetails;

// `FrontDoorBreadcrumb` is an async server component nested in the returned
// tree, and `renderToString` cannot suspend — expand the async layer first.
async function renderFrontDoor(page: number, hasMore: boolean, noindex = false): Promise<string> {
  const tree = await StaticListFrontDoor({
    boardDetails,
    angle: 40,
    climbs: [],
    hasMore,
    page,
    basePath: BASE,
    tree: 'config-tuple',
    noindex,
  });
  return renderToString(<>{await resolveServerTree(tree)}</>);
}

describe('front door pagination anchors', () => {
  it('links onward while the next page is still indexable', async () => {
    const html = await renderFrontDoor(FRONT_DOOR_MAX_INDEXABLE_PAGE - 1, true);

    expect(html).toContain(`rel="next"`);
    expect(html).toContain(`href="${BASE}?page=${FRONT_DOOR_MAX_INDEXABLE_PAGE}"`);
  });

  it('stops the walk at the last indexable page even when more climbs exist', async () => {
    const html = await renderFrontDoor(FRONT_DOOR_MAX_INDEXABLE_PAGE, true);

    // `noindex, follow` past the cap is an explicit "keep following links", so a
    // `next` chain gated on `hasMore` alone would invite crawlers into a
    // corridor thousands of pages deep, each hop a deeper OFFSET.
    expect(html).not.toContain('rel="next"');
    expect(html).toContain(`href="${BASE}?page=${FRONT_DOOR_MAX_INDEXABLE_PAGE - 1}"`);
  });

  it('still walks a deep grace-band page BACK into the indexable set', async () => {
    const html = await renderFrontDoor(FRONT_DOOR_MAX_INDEXABLE_PAGE + 1, true);

    expect(html).not.toContain('rel="next"');
    expect(html).toContain('rel="prev"');
    expect(html).toContain(`href="${BASE}?page=${FRONT_DOOR_MAX_INDEXABLE_PAGE}"`);
  });

  it('offers no anchor at either end of the walk — a disabled control, not a dead link', async () => {
    const html = await renderFrontDoor(1, false);

    expect(html).not.toContain('rel="prev"');
    expect(html).not.toContain('rel="next"');
    // `\sdisabled=""`, not a bare `disabled` inside `[^>]*`: MUI also puts a
    // `Mui-disabled` token in the class list, so the loose form would pass on a
    // control that merely LOOKS inert while still being a focusable dead link.
    expect(html.match(/<button[^>]*\sdisabled=""/g) ?? []).toHaveLength(2);
  });
});

describe('front door breadcrumb', () => {
  it('gives the list page an upward link home', async () => {
    const html = await renderFrontDoor(1, false);

    expect(html).toContain('href="/"');
    expect(html).toContain('aria-current="page"');
  });

  it('emits BreadcrumbList on page 1 of an indexed board', async () => {
    const html = await renderFrontDoor(1, false);

    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  it('omits BreadcrumbList past page 1 — those pages are self-canonical', async () => {
    // The crumbs describe the clean list URL. On `?page=2` that contradicts the
    // page's own canonical, so the visible crumbs stay and the schema does not.
    const html = await renderFrontDoor(2, true);

    expect(html).not.toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('aria-current="page"');
  });

  it('omits BreadcrumbList on a noindex board, which the CreativeWork payload also skips', async () => {
    const html = await renderFrontDoor(1, false, true);

    expect(html).not.toContain('"@type":"BreadcrumbList"');
  });
});
