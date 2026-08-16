import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { SITE_URL } from '@/app/lib/seo/base-url';
import BoardInstallQr from '../board-install-qr';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

// Capture the QRCodeSVG `value` so we can assert the encoded deep-link target
// without decoding the rendered matrix.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="qr" data-value={value} />,
}));

describe('BoardInstallQr', () => {
  it('encodes /b/{slug} with the kiosk attribution params against the canonical site URL', () => {
    render(<BoardInstallQr slug="main-kilter" />);
    // Derived from SITE_URL rather than a hardcoded domain, so the assertion
    // tracks the base URL instead of pinning the production host. The params are
    // spelled out: this string gets printed onto a kiosk screen, and a scan that
    // loses `medium=kiosk` is indistinguishable from someone typing the URL.
    expect(screen.getByTestId('qr').getAttribute('data-value')).toBe(`${SITE_URL}/b/main-kilter?src=qr&medium=kiosk`);
  });

  it('renders the install caption from the kiosk catalog', () => {
    render(<BoardInstallQr slug="main-kilter" />);
    expect(screen.getByText(tFromCatalog('kiosk', 'installQr.caption') as string)).toBeTruthy();
  });
});
