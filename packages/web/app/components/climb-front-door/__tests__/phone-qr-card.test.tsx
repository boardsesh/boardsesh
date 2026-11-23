import React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { buildStoreUrl } from '@/app/lib/store-links';
import { climbQrUrl } from '@/app/lib/gym-attribution';

vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const PhoneQrCard = (await import('../phone-qr-card')).default;

const STORE_LABELS = { ios: 'App Store', android: 'Google Play', update: 'Update', locale: 'en-US' } as const;

function renderCard(): string {
  return renderToString(
    <PhoneQrCard
      url={climbQrUrl('/b/the-kilter/40/view/abc-the-climb', 'en-US')}
      title="Scan to open this climb on your phone"
      body="Free on iPhone and Android."
      imageLabel="QR code that opens the climb on your phone"
      placement="climb-view"
      storeLabels={STORE_LABELS}
      qrLanding="climb"
    />,
  );
}

describe('PhoneQrCard', () => {
  it('draws the code in the server HTML, as dark modules on white', () => {
    const html = renderCard();
    const code = new DOMParser().parseFromString(html, 'text/html').querySelector('svg[role="img"]');

    expect(code?.getAttribute('aria-label')).toBe('QR code that opens the climb on your phone');
    expect(code?.querySelectorAll('path')).toHaveLength(2);
    expect(code?.querySelector('path[fill="#000000"]')?.getAttribute('d')?.length).toBeGreaterThan(100);
    expect(code?.querySelector('path[fill="#ffffff"]')).not.toBeNull();
  });

  it('is big enough to scan off a laptop screen, with the full 4-module quiet zone', () => {
    const code = new DOMParser().parseFromString(renderCard(), 'text/html').querySelector('svg[role="img"]');
    const side = Number(code?.getAttribute('viewBox')?.split(' ')[2]);
    const modules = side - 2 * 4;

    expect(code?.getAttribute('width')).toBe('148');
    // A QR symbol is 17 + 4 × version modules wide; anything else means the margin is not 4.
    expect((modules - 17) % 4).toBe(0);
    // Level L keeps a climb URL at version 7 or below: at least 2.8 CSS px a module.
    expect(148 / side).toBeGreaterThanOrEqual(2.75);
  });

  it('puts both stores beside it, untagged, so the cached HTML is the same for everyone', () => {
    const html = renderCard();

    expect(html).toContain(`href="${buildStoreUrl('ios', { placement: 'climb-view' }).replaceAll('&', '&amp;')}"`);
    expect(html).toContain(`href="${buildStoreUrl('android', { placement: 'climb-view' }).replaceAll('&', '&amp;')}"`);
    expect(html).not.toContain('climb-view.desktop');
  });

  // The card renders `QRCodeSVG` in a SERVER component so the code costs the
  // page no JavaScript. A `'use client'` directive in a later `qrcode.react`
  // would turn that import into a client reference and ship the whole encoder.
  it('relies on a qrcode.react build that is not a client module', () => {
    // `require` resolves `lib/index.js`; the package root is one level up.
    const packageRoot = dirname(dirname(createRequire(import.meta.url).resolve('qrcode.react')));

    for (const entry of ['lib/esm/index.js', 'lib/index.js']) {
      const source = readFileSync(join(packageRoot, entry), 'utf8');
      expect(source.slice(0, 200), entry).not.toMatch(/['"]use client['"]/);
    }
  });
});
