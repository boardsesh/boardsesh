// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { StrictMode, Suspense, useState, type ReactNode } from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { HttpQueryScope } from '../../../lib/graphql/http-query-scope';
import type { BoardConfig } from '../play-drawer-types';
import type { createScopedHttpFixture } from '../../../lib/graphql/__tests__/fixtures/scoped-http';
const ports = vi.hoisted(() => ({
  scope: null as HttpQueryScope | null,
  http: null as ReturnType<typeof createScopedHttpFixture> | null,
  auth: new Set<() => void>(),
}));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => {
    throw new Error('Unexpected native HTTP');
  },
  getOfflineSyncHttpClient: () => {
    throw new Error('Unexpected native offline HTTP');
  },
}));
vi.mock('../../../lib/graphql/use-http-query-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/graphql/use-http-query-scope')>();
  return { ...actual, useHttpQueryScope: () => ports.scope ?? actual.useHttpQueryScope() };
});
vi.mock('../../../lib/graphql/use-auth-token', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/graphql/use-auth-token.web')>(
    '../../../lib/graphql/use-auth-token.web',
  );
  return { subscribeHttpOperationScope: actual.subscribeHttpOperationScope };
});
vi.mock('../../../lib/auth-store.web', () => ({
  subscribeAuthTokenChanges: (listener: () => void) => {
    ports.auth.add(listener);
    return () => {
      ports.auth.delete(listener);
    };
  },
}));
vi.mock('../../../lib/browser-backend-client.web', () => ({
  expoBrowserBackendClient: { subscribe: (listener: () => void) => ports.http!.backend.subscribe(listener) },
}));
vi.mock('../../../lib/graphql/client.web', () => ({
  browserHttpClients: { subscribe: (listener: () => void) => ports.http!.facade.subscribe(listener) },
}));
import { useBetaVideoProducer, type BetaPinnedTarget } from '../../../lib/graphql/hooks/use-beta-links';
const { createScopedHttpFixture: makeHttp } = await import('../../../lib/graphql/__tests__/fixtures/scoped-http');
const { flushSync } = await vi.importActual<{ flushSync: (commit: () => void) => void }>('react-dom');
const config: BoardConfig = { boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '1', angle: 40 };
const climb = (uuid: string) => ({ uuid, name: `Owned ${uuid}` }) as Climb;
afterEach(() => {
  cleanup();
  ports.http?.dispose();
  ports.http = null;
  ports.scope = null;
  ports.auth.clear();
});
function selected() {
  const http = makeHttp();
  ports.http = http;
  ports.scope = http.scope();
  return http;
}
function host(options: { strict?: boolean; targetBoundary?: () => void } = {}) {
  const observed: Array<{ stage: string; opening: string | undefined }> = [];
  let original: ReturnType<typeof useBetaVideoProducer>;
  const wrapper = ({ children }: { children?: ReactNode }) =>
    options.strict ? <StrictMode>{children}</StrictMode> : <>{children}</>;
  const mounted = renderHook(
    ({ displayed }: { displayed: Climb }) => {
      const [target, setTarget] = useState<BetaPinnedTarget>();
      const [visible, setVisible] = useState(false);
      const producer = useBetaVideoProducer({
        displayedClimb: displayed,
        boardConfig: config,
        setTarget(next) {
          observed.push({ stage: 'target', opening: original.currentOpening()?.id });
          setTarget(next);
          options.targetBoundary?.();
        },
        setVisible(next) {
          observed.push({ stage: `visible:${next}`, opening: original.currentOpening()?.id });
          setVisible(next);
        },
      });
      original = producer;
      return { ...producer, target, visible };
    },
    { initialProps: { displayed: climb('A') }, wrapper },
  );
  return { ...mounted, observed };
}
it('preserves native pinned target/default close using real setters without credentials', () => {
  const mounted = host();
  const pinned = climb('PINNED');
  act(() => {
    mounted.result.current.openForClimb(pinned, config);
  });
  expect(mounted.result.current.scoped).toBe(false);
  expect(mounted.result.current.target).toEqual({ climb: pinned, boardConfig: config });
  expect(mounted.result.current.target?.climb).toBe(pinned);
  expect(mounted.result.current.visible).toBe(true);
  act(() => {
    mounted.result.current.close();
  });
  expect(mounted.result.current.visible).toBe(false);
});
it('stamps the actual selected opening before target and visible setters, with immutable pinned input', () => {
  const http = selected();
  const mounted = host();
  const pinned = climb('PINNED');
  const snapshot = { ...config };
  act(() => {
    mounted.result.current.openForClimb(pinned, snapshot);
  });
  const opening = mounted.result.current.opening!;
  expect(mounted.observed).toEqual([
    { stage: 'target', opening: opening.id },
    { stage: 'visible:true', opening: opening.id },
  ]);
  pinned.name = 'MUTATED';
  snapshot.angle = 20;
  expect(mounted.result.current.target?.climb.name).toBe('Owned PINNED');
  expect(mounted.result.current.target?.boardConfig.angle).toBe(40);
  expect(http.issueLease).not.toHaveBeenCalled();
  expect(http.performFetch).not.toHaveBeenCalled();
});
it('refuses old close after synchronous batched reopen while keeping the new opening live', () => {
  selected();
  const mounted = host();
  act(() => {
    mounted.result.current.open();
  });
  const first = mounted.result.current.opening!;
  const close = mounted.result.current.close;
  act(() => {
    mounted.result.current.open();
    close(first);
  });
  expect(mounted.result.current.opening).not.toBe(first);
  expect(mounted.result.current.visible).toBe(true);
  expect(() => first.assertAction()).toThrow();
  expect(mounted.result.current.opening!.assertAction).not.toThrow();
  act(() => {
    mounted.result.current.close(mounted.result.current.opening);
  });
  expect(mounted.result.current.visible).toBe(false);
});
it('pins the admitted target while committed entity ABA retires the original uninvoked opener', () => {
  selected();
  const mounted = host();
  const original = mounted.result.current.openForClimb;
  act(() => {
    original(climb('PINNED'), config);
  });
  act(() => {
    mounted.rerender({ displayed: climb('B') });
  });
  expect(mounted.result.current.target?.climb.uuid).toBe('PINNED');
  act(() => {
    mounted.rerender({ displayed: climb('A') });
    original(climb('OLD'), config);
  });
  expect(mounted.result.current.target?.climb.uuid).toBe('PINNED');
  act(() => {
    mounted.result.current.open();
  });
  expect(mounted.result.current.target?.climb.uuid).toBe('A');
});
it('preserves an uninvoked current callback across harmless objects and StrictMode layout re-setup', () => {
  selected();
  const mounted = host({ strict: true });
  const original = mounted.result.current.open;
  act(() => {
    mounted.rerender({ displayed: climb('A') });
  });
  act(() => {
    original();
  });
  expect(mounted.result.current.visible).toBe(true);
  expect(mounted.result.current.opening!.assertAction).not.toThrow();
});
it.each(['viewABA', 'deletion'] as const)(
  'refuses the actual retained callback after %s before target/setVisible',
  (retirement) => {
    const http = selected();
    const mounted = host();
    const original = mounted.result.current.open;
    if (retirement === 'viewABA') {
      act(() => {
        http.switchAccount('owned-B');
        http.switchAccount('owned-A');
        ports.scope = http.scope();
      });
    } else mounted.unmount();
    act(() => {
      original();
    });
    expect(mounted.observed).toEqual([]);
    expect(http.issueLease).not.toHaveBeenCalled();
    expect(http.performFetch).not.toHaveBeenCalled();
  },
);
it('stops a started action at a reentrant real setter before visibility and preserves a later current invocation', () => {
  const http = selected();
  let retire = true;
  const mounted = host({
    targetBoundary() {
      if (retire) {
        retire = false;
        http.switchAccount('owned-B');
        ports.scope = http.scope();
      }
    },
  });
  act(() => {
    mounted.result.current.open();
  });
  expect(mounted.observed.map((entry) => entry.stage)).toEqual(['target']);
  expect(mounted.result.current.visible).toBe(false);
  expect(() => mounted.result.current.opening?.assertAction()).toThrow();
  act(() => {
    mounted.rerender({ displayed: climb('A') });
  });
  act(() => {
    mounted.result.current.open();
  });
  expect(mounted.result.current.visible).toBe(true);
  expect(mounted.result.current.opening!.assertAction).not.toThrow();
});
it('retires an action started before actual same-owner Suspense layout cleanup, then admits an uninvoked current callback after reveal', () => {
  selected();
  let blocked = false;
  const pending = new Promise<void>(() => {});
  let hide!: () => void;
  let current!: ReturnType<typeof useBetaVideoProducer>;
  const shown: boolean[] = [];
  function Owner() {
    const [target, setTarget] = useState<BetaPinnedTarget>();
    const [visible, setVisible] = useState(false);
    current = useBetaVideoProducer({
      displayedClimb: climb('A'),
      boardConfig: config,
      setTarget(next) {
        setTarget(next);
        hide();
      },
      setVisible(next) {
        shown.push(next);
        setVisible(next);
      },
    });
    if (blocked) throw pending;
    return (
      <span>
        {target?.climb.uuid}:{String(visible)}
      </span>
    );
  }
  const screen = render(
    <Suspense fallback={<span>hidden</span>}>
      <Owner />
    </Suspense>,
  );
  hide = () => {
    flushSync(() => {
      blocked = true;
      screen.rerender(
        <Suspense fallback={<span>hidden</span>}>
          <Owner />
        </Suspense>,
      );
    });
  };
  const original = current.open;
  act(() => {
    original();
  });
  expect(screen.getByText('hidden')).toBeTruthy();
  expect(shown).toEqual([]);
  act(() => {
    blocked = false;
    screen.rerender(
      <Suspense fallback={<span>hidden</span>}>
        <Owner />
      </Suspense>,
    );
  });
  hide = () => {};
  act(() => {
    original();
  });
  expect(shown).toEqual([true]);
  expect(current.opening!.assertAction).not.toThrow();
});
// The test exercises the consumed hook, not a duplicated PlayCore callback or
// full player/BLE mount. These source assertions bind its actual production ports.
it('binds PlayCore and its kept host to the same consumed producer handlers', () => {
  const componentRoot = existsSync('src/components/play-drawer/PlayCore.tsx')
    ? 'src/components/play-drawer/'
    : 'packages/mobile/src/components/play-drawer/';
  const source = readFileSync(`${componentRoot}PlayCore.tsx`, 'utf8');
  expect(source).toContain('open: handleOpenAddBetaVideo,');
  expect(source).toContain('openForClimb: handleOpenAddBetaVideoForClimb,');
  expect(source).toContain('close: handleCloseAddBetaVideo,');
  expect(source).toContain('setTarget: setBetaVideoTarget,');
  expect(source).toContain('setVisible: setAddBetaVideoOpen,');
  expect(source).toContain('onAddBetaVideo={isAuthenticated ? handleOpenAddBetaVideo : undefined}');
  expect(source).toContain('onAddBetaVideo={handleOpenAddBetaVideoForClimb}');
  expect(source).toContain('handleCloseAddBetaVideo={handleCloseAddBetaVideo}');
  const hosts = readFileSync(`${componentRoot}PlayCoreSheetHosts.tsx`, 'utf8');
  expect(hosts).toContain('{...(betaOpening ? { opening: betaOpening } : {})}');
  expect(hosts).toContain('key={`beta-${composerCredentialScope}`}');
});
