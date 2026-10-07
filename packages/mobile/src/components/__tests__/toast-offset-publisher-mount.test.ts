import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ToastOffsetPublisher reads useBottomChromeMetrics(), which throws in dev and
// silently falls back to zero chrome in release when no provider is above it.
// A release toast would then sit under the tab bar with nothing failing, so pin
// the mount point in the root layout: inside the provider, and only once.
describe('root layout toast offset publisher', () => {
  const layoutSource = readFileSync(join(__dirname, '../../../app/_layout.tsx'), 'utf8');

  it('mounts ToastOffsetPublisher once, inside BottomChromeMetricsProvider', () => {
    const open = layoutSource.indexOf('<BottomChromeMetricsProvider>');
    const close = layoutSource.indexOf('</BottomChromeMetricsProvider>');
    const publisher = layoutSource.indexOf('<ToastOffsetPublisher />');

    expect(open).toBeGreaterThan(-1);
    expect(layoutSource.split('<ToastOffsetPublisher />')).toHaveLength(2);
    expect(publisher).toBeGreaterThan(open);
    expect(publisher).toBeLessThan(close);
  });

  it('keeps the toast overlay in ToastProvider, outside BottomSheetModalProvider', () => {
    // Gorhom's web portal host paints after its children; a toast rendered
    // inside it would sit under every web sheet.
    expect(layoutSource.indexOf('<ToastProvider>')).toBeLessThan(layoutSource.indexOf('<BottomSheetModalProvider>'));
    expect(layoutSource).not.toContain('<ToastHost');
  });
});
