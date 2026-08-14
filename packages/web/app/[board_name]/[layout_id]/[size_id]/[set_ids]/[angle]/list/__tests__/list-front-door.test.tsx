import { describe, expect, it } from 'vite-plus/test';
import {
  FRONT_DOOR_MAX_INDEXABLE_PAGE,
  FRONT_DOOR_PAGE_SIZE,
  frontDoorPagePath,
  isIndexableFrontDoorPage,
  parseFrontDoorPage,
} from '@/app/lib/seo/list-page-robots';

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
});
