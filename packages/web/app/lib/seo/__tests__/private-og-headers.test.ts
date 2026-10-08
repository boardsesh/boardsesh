import { describe, expect, it } from 'vite-plus/test';
import { createPrivateOgImageHeaders } from '../private-og-headers';

describe('identity-bearing preview caches', () => {
  it.each([undefined, 'old-public-version'])('never caches personal images with version %s', (version) => {
    const headers = createPrivateOgImageHeaders({ contentType: 'image/png', version });
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(headers['CDN-Cache-Control']).toBe('no-store');
    expect(headers['Vercel-CDN-Cache-Control']).toBe('no-store');
  });
});
