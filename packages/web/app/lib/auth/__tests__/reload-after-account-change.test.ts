// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import { reloadAfterAccountChange, type ReloadTarget } from '../reload-after-account-change';

function pageAt(pathname: string) {
  const listeners = new Map<string, () => void>();
  const replace = vi.fn<(url: string | URL) => void>();
  const reload = vi.fn<() => void>();
  const target: ReloadTarget = {
    location: { pathname, replace, reload },
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
  };
  return { target, replace, reload, dispatch: (type: string) => listeners.get(type)?.() };
}

describe('reloadAfterAccountChange', () => {
  it.each([
    ['/profile/user-a', '/'],
    ['/es/settings', '/es'],
    ['/de', '/de'],
  ])('starts %s over at its locale root %s', (pathname, root) => {
    const page = pageAt(pathname);

    reloadAfterAccountChange(page.target);

    expect(page.replace).toHaveBeenCalledExactlyOnceWith(root);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it.each(['/kiosk/crag-gym/front-desk', '/fr/kiosk/crag-gym/front-desk', '/embed/gym/gym-uuid/leaderboard'])(
    'reloads the unattended display %s where it is, never at the homepage',
    (pathname) => {
      const page = pageAt(pathname);

      reloadAfterAccountChange(page.target);

      expect(page.reload).toHaveBeenCalledOnce();
      expect(page.replace).not.toHaveBeenCalled();
    },
  );

  it('tries again on the next tap or key press when a leave prompt kept the page', () => {
    const page = pageAt('/settings');

    reloadAfterAccountChange(page.target);
    page.dispatch('pointerdown');
    page.dispatch('keydown');

    expect(page.replace).toHaveBeenCalledTimes(3);
  });
});
