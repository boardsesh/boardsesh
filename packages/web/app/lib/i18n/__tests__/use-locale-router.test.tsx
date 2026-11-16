import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { browserSessionGuard } from '@/app/lib/auth/session-guard';
import { useLocaleRouter } from '../use-locale-router';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/es/settings' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'es' } }) }));

const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');

beforeEach(() => {
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[GUARD_KEY];
  router.push.mockReset();
  router.replace.mockReset();
});

describe('useLocaleRouter session generation', () => {
  it('drops navigation asked for by a render from before an account change', () => {
    const guard = browserSessionGuard();
    guard.accept(null);
    const { result } = renderHook(() => useLocaleRouter());
    const heldAcrossSignIn = result.current;

    heldAcrossSignIn.push('/playlists');
    expect(router.push).toHaveBeenCalledWith('/es/playlists');

    act(() => {
      guard.accept({ userId: 'user-a', authSessionId: 'login-a' });
    });
    heldAcrossSignIn.push('/orders');
    heldAcrossSignIn.replace('/orders');
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();

    result.current.replace('/orders');
    expect(router.replace).toHaveBeenCalledWith('/es/orders');
  });
});
