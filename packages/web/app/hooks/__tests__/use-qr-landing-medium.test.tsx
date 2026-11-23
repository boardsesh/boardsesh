import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import { __resetQrLandingForTests } from '@/app/lib/qr-landing';

// The router's pathname, moved by each test the way a client-side navigation would.
const routerPathname = vi.hoisted(() => ({ current: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => routerPathname.current }));

const { useQrLandingMedium } = await import('../use-qr-landing-medium');

/** Navigate the way Next does: the address bar and the router pathname move together. */
function navigateTo(url: string): void {
  window.history.replaceState(null, '', url);
  routerPathname.current = new URL(url, window.location.origin).pathname;
}

beforeEach(() => {
  __resetQrLandingForTests();
  navigateTo('/');
});

describe('useQrLandingMedium', () => {
  it('reads the scanned medium once mounted', () => {
    navigateTo('/b/garage-wall/40/list?src=qr&medium=board');

    const { result } = renderHook(() => useQrLandingMedium('board'));

    expect(result.current).toBe('board');
  });

  it('drops the medium when the same component lands on a page nobody scanned', () => {
    navigateTo('/b/garage-wall/40/list?src=qr&medium=board');
    const { result, rerender } = renderHook(() => useQrLandingMedium('board'));
    expect(result.current).toBe('board');

    navigateTo('/b/the-kilter/40/list');
    rerender();

    expect(result.current).toBeNull();
  });

  it('gets the medium back on returning to the scanned page', () => {
    navigateTo('/b/garage-wall/40/list?src=qr&medium=board');
    const { result, rerender } = renderHook(() => useQrLandingMedium('board'));

    navigateTo('/b/the-kilter/40/list');
    rerender();
    navigateTo('/b/garage-wall/40/list');
    rerender();

    expect(result.current).toBe('board');
  });

  it('reads nothing for the gym poster medium, which no board code prints', () => {
    navigateTo('/b/garage-wall/40/list?src=qr&medium=poster');

    const { result } = renderHook(() => useQrLandingMedium('board'));

    expect(result.current).toBeNull();
  });

  it('reads nothing when turned off', () => {
    navigateTo('/b/garage-wall/40/list?src=qr&medium=board');

    const { result } = renderHook(() => useQrLandingMedium(null));

    expect(result.current).toBeNull();
  });

  it('reads the desktop code on a climb page', () => {
    navigateTo('/b/the-kilter/40/view/abc-the-climb?src=qr&medium=desktop');

    const { result } = renderHook(() => useQrLandingMedium('climb'));

    expect(result.current).toBe('desktop');
  });

  it('reads nothing for a board code on a climb reader', () => {
    navigateTo('/b/the-kilter/40/view/abc-the-climb?src=qr&medium=board');

    const { result } = renderHook(() => useQrLandingMedium('climb'));

    expect(result.current).toBeNull();
  });
});
