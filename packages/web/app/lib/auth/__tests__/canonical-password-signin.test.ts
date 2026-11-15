// @vitest-environment node
import { describe, it, expect, vi } from 'vite-plus/test';
import { BROWSER_PASSWORD_BROWSER_PATHS as paths } from '@boardsesh/auth-protocol/browser-password-browser-v1';
import {
  BROWSER_COORDINATOR_LOCK,
  BROWSER_COORDINATOR_PUBLIC_PATHS,
} from '@boardsesh/auth-protocol/browser-coordinator';
import { signInCanonicalPassword } from '../canonical-password-signin';
import { readSettledPasswordBody } from '../browser-password-body';
const origin = 'https://www.boardsesh.test',
  source = { bindingId: 'a'.repeat(64), version: 7 },
  target = { ...source, version: 8 },
  operationKey = 'b'.repeat(64);
const fetchUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function fixture(recovery = false) {
  let locked = false;
  const trace: string[] = [];
  const locks = {
    request: vi.fn(async (name: string, _options: unknown, invoke: () => Promise<void>) => {
      expect(name).toBe(BROWSER_COORDINATOR_LOCK);
      expect(locked).toBe(false);
      locked = true;
      trace.push('lock');
      try {
        await invoke();
      } finally {
        locked = false;
        trace.push('unlock');
      }
    }),
  };
  const responses = new Map<string, unknown>([
    [paths.acknowledge, recovery ? { status: 'recovered', operationKey, cursor: target } : { status: 'none' }],
    [BROWSER_COORDINATOR_PUBLIC_PATHS.observe, { status: 'ready', cursor: source }],
    ['/api/auth/csrf', { csrfToken: 'actual-csrf' }],
    [paths.prepare, { status: 'prepared', operationKey, sourceCursor: source, targetCursor: target }],
    [paths.commit, { status: 'committed', operationKey, cursor: target }],
    [paths.confirm, { status: 'confirmed', operationKey, cursor: target, url: origin + '/settings' }],
  ]);
  const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(locked).toBe(true);
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', keepalive: false, redirect: 'error' });
    const path = new URL(fetchUrl(input)).pathname;
    trace.push(path);
    return Response.json(responses.get(path));
  });
  const preflight = vi.fn(async () => {
    expect(locked).toBe(false);
    trace.push('preflight');
    return source;
  });
  const navigate = vi.fn();
  const controller = new AbortController();
  const input = {
    canonicalOrigin: origin,
    email: ' exact@example.test ',
    password: '  NUL\0ß ',
    callbackUrl: '/settings',
    redirect: false,
    signal: controller.signal,
  };
  const dependencies = { currentOrigin: origin, locks, preflight, send: send as typeof fetch, navigate };
  return {
    input,
    dependencies,
    send,
    preflight,
    responses,
    trace,
    controller,
    get locked() {
      return locked;
    },
  };
}
describe('canonical password physical network lock', () => {
  it('recovers and confirms before preflight, without another password comparison', async () => {
    const current = fixture(true);
    expect(await signInCanonicalPassword(current.input, current.dependencies)).toMatchObject({
      ok: true,
      url: origin + '/settings',
    });
    expect(current.trace).toEqual(['lock', paths.acknowledge, paths.confirm, 'unlock']);
    expect(current.preflight).not.toHaveBeenCalled();
  });
  it('releases initial lock before frame preflight, pins cursor, then locks the whole publication', async () => {
    const current = fixture();
    expect(await signInCanonicalPassword(current.input, current.dependencies)).toMatchObject({
      ok: true,
      url: origin + '/settings',
    });
    expect(current.trace).toEqual([
      'lock',
      paths.acknowledge,
      'unlock',
      'preflight',
      'lock',
      BROWSER_COORDINATOR_PUBLIC_PATHS.observe,
      '/api/auth/csrf',
      paths.prepare,
      paths.commit,
      paths.confirm,
      'unlock',
    ]);
    const form = current.send.mock.calls.find(([url]) => fetchUrl(url).endsWith(paths.prepare))?.[1]?.body;
    expect(form).toBeInstanceOf(URLSearchParams);
    expect((form as URLSearchParams).get('password')).toBe(current.input.password);
    expect([...(form as URLSearchParams).keys()]).not.toContain('credentialKind');
    expect(current.preflight).toHaveBeenCalledWith(origin, current.input.signal);
    for (const [url, init] of current.send.mock.calls)
      if (!fetchUrl(url).endsWith(paths.prepare))
        expect(typeof init?.body === 'string' ? init.body : '').not.toContain(current.input.password);
  });
  it('holds the lock through actual body settlement before confirmation', async () => {
    const current = fixture(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = current.send.getMockImplementation()!;
    current.send.mockImplementation(async (url, init) => {
      if (!fetchUrl(url).endsWith(paths.acknowledge)) return original(url, init);
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ status: 'recovered', operationKey, cursor: target })),
            );
            await gate;
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const pending = signInCanonicalPassword(current.input, current.dependencies);
    await vi.waitFor(() => expect(current.locked).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(current.send).toHaveBeenCalledOnce();
    expect(current.preflight).not.toHaveBeenCalled();
    release();
    await pending;
    expect(current.locked).toBe(false);
    expect(current.send).toHaveBeenCalledTimes(2);
  });
  it('owns cancellation when the response arrives already aborted at headers', async () => {
    const current = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelling = false;
    current.send.mockImplementation(async () => {
      const response = new Response(
        new ReadableStream({
          async cancel() {
            cancelling = true;
            await gate;
            throw new Error('Owned disposal failure');
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
      current.controller.abort();
      return response;
    });
    let settled = false;
    const pending = signInCanonicalPassword(current.input, current.dependencies)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(current.send).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      expect(cancelling).toBe(true);
      expect(settled).toBe(false);
      expect(current.locked).toBe(true);
      expect(current.preflight).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(current.locked).toBe(false);
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('PASSWORD_BODY_UNAVAILABLE');
  });
  it('does not detach a timeout rejection while already-aborted body cancellation is held', async () => {
    const controller = new AbortController();
    controller.abort();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelling = false;
    let settled = false;
    const pending = readSettledPasswordBody(
      new ReadableStream({
        async cancel() {
          cancelling = true;
          await gate;
        },
      }),
      controller.signal,
      1024,
      5,
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      expect(cancelling).toBe(true);
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('PASSWORD_BODY_UNAVAILABLE');
  });
  it('awaits body cancellation itself before releasing the canonical lock', async () => {
    const current = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelling = false;
    current.send.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16_385));
            },
            async cancel() {
              cancelling = true;
              await gate;
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const pending = signInCanonicalPassword(current.input, current.dependencies).catch(() => undefined);
    await vi.waitFor(() => expect(cancelling).toBe(true));
    expect(current.locked).toBe(true);
    expect(current.preflight).not.toHaveBeenCalled();
    release();
    await pending;
    expect(current.locked).toBe(false);
  });
  it.each(['stale-cursor', 'unavailable-prepare', 'wrong-operation', 'wrong-target'] as const)(
    'refuses %s without subsequent publication',
    async (fault) => {
      const current = fixture();
      if (fault === 'stale-cursor')
        current.responses.set(BROWSER_COORDINATOR_PUBLIC_PATHS.observe, {
          status: 'ready',
          cursor: { ...source, version: 6 },
        });
      if (fault === 'unavailable-prepare') current.responses.set(paths.prepare, { status: 'unavailable' });
      if (fault === 'wrong-operation')
        current.responses.set(paths.commit, { status: 'committed', operationKey: 'f'.repeat(64), cursor: target });
      if (fault === 'wrong-target')
        current.responses.set(paths.commit, { status: 'committed', operationKey, cursor: { ...target, version: 9 } });
      await expect(signInCanonicalPassword(current.input, current.dependencies)).rejects.toThrow();
      expect(current.dependencies.navigate).not.toHaveBeenCalled();
      expect(current.send.mock.calls.some(([url]) => fetchUrl(url).endsWith(paths.confirm))).toBe(false);
    },
  );
  it('returns the installed wrong-password contract without commit or navigation', async () => {
    const current = fixture();
    current.responses.set(paths.prepare, {
      status: 'framework-result',
      result: { url: origin + '/auth/login?error=CredentialsSignin', status: 401 },
    });
    expect(await signInCanonicalPassword(current.input, current.dependencies)).toEqual({
      error: 'CredentialsSignin',
      status: 401,
      ok: false,
      url: null,
    });
    expect(current.send.mock.calls.some(([url]) => fetchUrl(url).endsWith(paths.commit))).toBe(false);
  });
  it('navigates only after delivered proof confirmation and lock release', async () => {
    const current = fixture();
    current.dependencies.navigate.mockImplementation(() => {
      expect(current.locked).toBe(false);
    });
    expect(await signInCanonicalPassword({ ...current.input, redirect: true }, current.dependencies)).toBeUndefined();
    expect(current.dependencies.navigate).toHaveBeenCalledWith(origin + '/settings');
  });
  it('never falls back when recovery is unavailable or the origin is noncanonical', async () => {
    const current = fixture();
    current.responses.set(paths.acknowledge, { status: 'unavailable' });
    await expect(signInCanonicalPassword(current.input, current.dependencies)).rejects.toThrow();
    expect(current.preflight).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledOnce();
    await expect(
      signInCanonicalPassword(current.input, { ...current.dependencies, currentOrigin: 'https://app.boardsesh.test' }),
    ).rejects.toThrow();
    expect(current.send).toHaveBeenCalledOnce();
  });
});
