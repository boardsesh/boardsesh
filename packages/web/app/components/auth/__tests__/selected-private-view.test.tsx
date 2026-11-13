import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { SessionContext, type SessionContextValue } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { Session } from 'next-auth';

const control = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  refresh: vi.fn(),
  refreshSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: control.refresh }) }));
vi.mock('@/app/lib/auth/browser-backend-client', () => ({
  browserBackendClient: new Proxy(
    {},
    {
      get(_target, property) {
        return Reflect.get(control.client!, property);
      },
    },
  ),
}));
import SelectedPrivateView from '../selected-private-view';
import { WEB_SESSION_REFRESH_EVENT } from '@/app/lib/auth/web-session-events';

function session(userId = 'climber-a', version = 1) {
  const browserSelection = {
    userId,
    authSessionId: `${userId}-login`,
    generation: 2,
    cursor: { bindingId: 'a'.repeat(64), version },
  };
  return {
    user: { id: userId },
    authSessionId: browserSelection.authSessionId,
    authGeneration: browserSelection.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection,
  };
}
function context(current: Session | null): SessionContextValue {
  return current
    ? { status: 'authenticated', data: current, update: async () => current }
    : { status: 'unauthenticated', data: null, update: async () => null };
}
function view(current: Session | null, expected = session().browserSelection) {
  return (
    <SessionContext.Provider value={context(current)}>
      <SelectedPrivateView expectedOwner={expected} fallback={<p>Public fallback</p>}>
        <p>Private client content</p>
      </SelectedPrivateView>
    </SessionContext.Provider>
  );
}

beforeEach(() => {
  control.refresh.mockReset();
  control.refreshSession.mockReset();
  window.addEventListener(WEB_SESSION_REFRESH_EVENT, control.refreshSession);
  control.client = createBrowserBackendClient({
    ready: () => true,
    fetch: vi.fn<typeof fetch>(async () =>
      Response.json({
        status: 'admitted',
        token: 'bsbd1_PRIVATE',
        usableForMs: 60_000,
        owner: session().browserSelection,
      }),
    ),
    endpoint: '/owned-lease',
    now: () => 0,
    schedule: () => () => {},
  });
});
afterEach(() => {
  cleanup();
  window.removeEventListener(WEB_SESSION_REFRESH_EVENT, control.refreshSession);
  control.client?.dispose();
  control.client = null;
});

describe('selected private client islands', () => {
  it('hides disposed views without starting another primary read', () => {
    const current = session();
    control.client!.acceptSession(current);
    render(view(current));
    act(() => control.client!.dispose());
    expect(screen.queryByText('Private client content')).toBeNull();
    expect(control.refreshSession).not.toHaveBeenCalled();
  });
  it('renders only public fallback during server HTML rendering, even with an accepted client fixture', () => {
    const current = session();
    control.client!.acceptSession(current);
    const html = renderToString(view(current));
    expect(html).toContain('Public fallback');
    expect(html).not.toContain('Private client content');
  });

  it('requires the actual accepted context object, then mounts the matching private client', () => {
    const current = session();
    control.client!.acceptSession(current);
    const { rerender } = render(view(structuredClone(current)));
    expect(screen.queryByText('Private client content')).toBeNull();
    rerender(view(current));
    expect(screen.getByText('Private client content')).toBeTruthy();
  });

  it('immediately hides private children after a real scope invalidation and recovers only with a new context', async () => {
    const current = session();
    control.client!.acceptSession(current);
    const lease = await control.client!.acquire(current.browserSelection);
    const scope = control.client!.capture(lease.token)!;
    const { rerender } = render(view(current));
    expect(screen.getByText('Private client content')).toBeTruthy();
    act(() => control.client!.invalidate(scope));
    expect(screen.queryByText('Private client content')).toBeNull();
    expect(control.refreshSession).toHaveBeenCalledOnce();
    rerender(view(current));
    expect(control.refreshSession).toHaveBeenCalledOnce();
    const refreshed = session();
    act(() => {
      control.client!.acceptSession(refreshed);
    });
    expect(screen.queryByText('Private client content')).toBeNull();
    rerender(view(refreshed));
    expect(screen.getByText('Private client content')).toBeTruthy();
  });

  it.each(['userId', 'authSessionId', 'generation', 'bindingId', 'version'] as const)(
    'hides cached server labels with a mismatched %s and refreshes only once',
    (field) => {
      const current = session();
      const expected = structuredClone(current.browserSelection);
      if (field === 'userId') expected.userId = 'climber-b';
      if (field === 'authSessionId') expected.authSessionId = 'another-login';
      if (field === 'generation') expected.generation += 1;
      if (field === 'bindingId') expected.cursor.bindingId = 'b'.repeat(64);
      if (field === 'version') expected.cursor.version += 1;
      control.client!.acceptSession(current);
      const { rerender } = render(view(current, expected));
      expect(screen.queryByText('Private client content')).toBeNull();
      expect(control.refresh).toHaveBeenCalledOnce();
      rerender(view(current, expected));
      expect(control.refresh).toHaveBeenCalledOnce();
    },
  );

  it('retirement cannot become anonymous acceptance or revive the earlier A view after exact-tuple ABA', () => {
    const first = session();
    control.client!.acceptSession(first);
    const { rerender } = render(view(first));
    act(() => control.client!.retire());
    expect(screen.queryByText('Private client content')).toBeNull();
    act(() => {
      control.client!.acceptSession(session('climber-b', 2));
      control.client!.acceptSession(session());
    });
    rerender(view(first));
    expect(screen.queryByText('Private client content')).toBeNull();
    rerender(view(null));
    expect(screen.queryByText('Private client content')).toBeNull();
  });

  it('shares one route refresh across several stale islands', () => {
    const current = session();
    control.client!.acceptSession(current);
    render(
      <SessionContext.Provider value={context(current)}>
        {[1, 2, 3].map((version) => (
          <SelectedPrivateView key={version} expectedOwner={session('climber-b', version).browserSelection}>
            <p>Private client content</p>
          </SelectedPrivateView>
        ))}
      </SessionContext.Provider>,
    );
    expect(control.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText('Private client content')).toBeNull();
  });
});
