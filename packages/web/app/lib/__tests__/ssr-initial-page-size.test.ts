import { describe, it, expect } from 'vite-plus/test';
import { MAX_PAGE_SIZE, SSR_INITIAL_PAGE_SIZE, resolveSsrInitialPageSize } from '@/app/lib/climb-list-constants';

describe('resolveSsrInitialPageSize', () => {
  it('returns the small initial batch on page=0 with a default page size', () => {
    expect(resolveSsrInitialPageSize(0, 20)).toBe(SSR_INITIAL_PAGE_SIZE);
  });

  it('caps page=0 to SSR_INITIAL_PAGE_SIZE even if a larger page size is requested', () => {
    expect(resolveSsrInitialPageSize(0, 50)).toBe(SSR_INITIAL_PAGE_SIZE);
  });

  it('aggregates pages 0..N for page>0 (deep-link)', () => {
    expect(resolveSsrInitialPageSize(1, 20)).toBe(40);
  });

  it('caps the aggregated size at MAX_PAGE_SIZE when the request would exceed it', () => {
    // (3 + 1) * 30 = 120 > MAX_PAGE_SIZE (100)
    expect(resolveSsrInitialPageSize(3, 30)).toBe(MAX_PAGE_SIZE);
  });

  it('returns the exact aggregated size when under MAX_PAGE_SIZE', () => {
    // (2 + 1) * 10 = 30
    expect(resolveSsrInitialPageSize(2, 10)).toBe(30);
  });
});
