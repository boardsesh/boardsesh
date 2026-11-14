// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_COORDINATOR_LOCK } from '@boardsesh/auth-protocol/browser-coordinator';
import { startCanonicalProviderSignin } from '../canonical-provider-start';

const origin = 'https://www.canonical-provider.example.test';
const google = 'https://accounts.google.com/o/oauth2/v2/auth?state=actual-state';
const apple = 'https://appleid.apple.com/auth/authorize?state=actual-state';
function href(target: RequestInfo | URL): string {
  return typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
}
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function setup(provider: 'google' | 'apple' = 'google') {
  const controller = new AbortController();
  const trace: string[] = [];
  let held = false;
  const send = vi.fn<typeof fetch>(async (url, settings) => {
    expect(held).toBe(true);
    expect(settings?.credentials).toBe('same-origin');
    expect(settings?.keepalive).toBe(false);
    expect(settings?.redirect).toBe('error');
    if (href(url).endsWith('/acknowledge')) {
      trace.push('ack-settled');
      return Response.json({ outcome: 'none' });
    }
    if (href(url).endsWith('/csrf')) {
      trace.push('csrf-settled');
      return Response.json({ csrfToken: 'actual-csrf' });
    }
    trace.push('signin-settled');
    expect(href(url)).toBe(`${origin}/api/auth/signin/${provider}`);
    expect(settings?.method).toBe('POST');
    expect(settings?.body).toBeInstanceOf(URLSearchParams);
    if (!(settings?.body instanceof URLSearchParams)) throw new Error('Expected the actual sign-in form body');
    expect(settings.body.toString()).toContain('json=true');
    return Response.json({ url: provider === 'google' ? google : apple });
  });
  const dependencies = {
    currentOrigin: origin,
    locks: {
      request: vi.fn(
        async (name: string, options: { mode: 'exclusive'; signal: AbortSignal }, invoke: () => Promise<void>) => {
          expect(name).toBe(BROWSER_COORDINATOR_LOCK);
          expect(options.mode).toBe('exclusive');
          held = true;
          trace.push('parent-lock');
          try {
            await invoke();
          } finally {
            trace.push('parent-release');
            held = false;
          }
        },
      ),
    },
    preflight: vi.fn(async () => {
      expect(held).toBe(false);
      trace.push('preflight-settled');
    }),
    send,
    beforeSignin: vi.fn(async () => {
      expect(held).toBe(true);
      trace.push('attempt-settled');
    }),
    navigate: vi.fn((destination: string) => {
      expect(held).toBe(false);
      trace.push(`navigate:${destination}`);
    }),
  };
  const input = {
    canonicalOrigin: origin,
    provider,
    callbackUrl: `${origin}/api/auth/native/callback?attemptId=${'a'.repeat(32)}`,
    signal: controller.signal,
  };
  return { input, dependencies, send, controller, trace, held: () => held };
}
describe('canonical WWW provider start physical network settlement', () => {
  it.each(['google', 'apple'] as const)(
    'preflights before the WWW lock and settles %s ACK/attempt/CSRF/start before navigation',
    async (provider) => {
      const fixture = setup(provider);
      await startCanonicalProviderSignin(fixture.input, fixture.dependencies);
      expect(fixture.trace).toEqual([
        'preflight-settled',
        'parent-lock',
        'ack-settled',
        'attempt-settled',
        'csrf-settled',
        'signin-settled',
        'parent-release',
        `navigate:${provider === 'google' ? google : apple}`,
      ]);
      expect(fixture.send).toHaveBeenCalledTimes(3);
    },
  );
  it('holds the lock when an aborted fetch ignores abort until its real settlement', async () => {
    const fixture = setup();
    const network = deferred<Response>();
    const started = deferred<void>();
    const original = fixture.send.getMockImplementation()!;
    fixture.send.mockImplementation(async (url, settings) => {
      if (href(url).endsWith('/signin/google')) {
        started.resolve();
        return network.promise;
      }
      return original(url, settings);
    });
    const operation = startCanonicalProviderSignin(fixture.input, fixture.dependencies);
    await started.promise;
    fixture.controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.held()).toBe(true);
    expect(fixture.dependencies.navigate).not.toHaveBeenCalled();
    network.resolve(Response.json({ url: google }));
    await expect(operation).rejects.toThrow('PROVIDER_SIGNIN_UNAVAILABLE');
    expect(fixture.held()).toBe(false);
    expect(fixture.send).toHaveBeenCalledTimes(3);
  });
  it('holds the lock through a pending signin response body even after abort', async () => {
    const fixture = setup();
    const started = deferred<void>();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const original = fixture.send.getMockImplementation()!;
    fixture.send.mockImplementation(async (url, settings) => {
      if (href(url).endsWith('/signin/google'))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              started.resolve();
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      return original(url, settings);
    });
    const operation = startCanonicalProviderSignin(fixture.input, fixture.dependencies);
    await started.promise;
    fixture.controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.held()).toBe(true);
    expect(fixture.dependencies.navigate).not.toHaveBeenCalled();
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify({ url: google })));
    bodyController.close();
    await expect(operation).rejects.toThrow('PROVIDER_SIGNIN_UNAVAILABLE');
    expect(fixture.held()).toBe(false);
  });
  it('settles a non-JSON body before releasing the lock on refusal', async () => {
    const fixture = setup();
    const started = deferred<void>();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const original = fixture.send.getMockImplementation()!;
    fixture.send.mockImplementation(async (url, settings) => {
      if (href(url).endsWith('/signin/google'))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              started.resolve();
            },
          }),
          { headers: { 'Content-Type': 'text/plain' } },
        );
      return original(url, settings);
    });
    const operation = startCanonicalProviderSignin(fixture.input, fixture.dependencies);
    await started.promise;
    expect(fixture.held()).toBe(true);
    bodyController.enqueue(new TextEncoder().encode('refused'));
    bodyController.close();
    await expect(operation).rejects.toThrow();
    expect(fixture.held()).toBe(false);
    expect(fixture.dependencies.navigate).not.toHaveBeenCalled();
  });
  it.each([
    'https://accounts.google.com.evil.example/o/oauth2/v2/auth?state=x',
    'http://accounts.google.com/o/oauth2/v2/auth?state=x',
    'https://appleid.apple.com/auth/authorize?state=x',
    `${google}#fragment`,
    `${google}&state=second`,
    'https://accounts.google.com/wrong?state=x',
  ])('refuses unqualified navigation %s after complete settlement', async (url) => {
    const fixture = setup();
    const original = fixture.send.getMockImplementation()!;
    fixture.send.mockImplementation(async (target, settings) =>
      href(target).endsWith('/signin/google') ? Response.json({ url }) : original(target, settings),
    );
    await expect(startCanonicalProviderSignin(fixture.input, fixture.dependencies)).rejects.toThrow();
    expect(fixture.dependencies.navigate).not.toHaveBeenCalled();
    expect(fixture.held()).toBe(false);
    expect(fixture.send).toHaveBeenCalledTimes(3);
  });
  it.each(['identity_changed', 'unavailable'] as const)(
    'does not start new OAuth after ACK %s and never retries',
    async (outcome) => {
      const fixture = setup();
      fixture.send.mockResolvedValue(
        Response.json({ outcome }, { status: outcome === 'identity_changed' ? 409 : 503 }),
      );
      await expect(startCanonicalProviderSignin(fixture.input, fixture.dependencies)).rejects.toThrow();
      expect(fixture.send).toHaveBeenCalledOnce();
      expect(fixture.dependencies.navigate).not.toHaveBeenCalled();
    },
  );
  it('does not acquire the parent lock when canonical frame preflight refuses', async () => {
    const fixture = setup();
    fixture.dependencies.preflight.mockRejectedValue(new Error('COORDINATOR_UNAVAILABLE'));
    await expect(startCanonicalProviderSignin(fixture.input, fixture.dependencies)).rejects.toThrow();
    expect(fixture.dependencies.locks.request).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it.each(['origin', 'locks', 'provider', 'aborted'] as const)(
    'refuses missing or unqualified %s before any transport',
    async (fault) => {
      const fixture = setup();
      if (fault === 'aborted') fixture.controller.abort();
      const input = {
        ...fixture.input,
        ...(fault === 'provider' ? { provider: 'facebook' as unknown as 'google' } : {}),
      };
      const dependencies = {
        ...fixture.dependencies,
        ...(fault === 'origin' ? { currentOrigin: 'https://app.example.test' } : {}),
        ...(fault === 'locks' ? { locks: undefined } : {}),
      };
      await expect(startCanonicalProviderSignin(input, dependencies)).rejects.toThrow();
      expect(fixture.send).not.toHaveBeenCalled();
      expect(fixture.dependencies.preflight).not.toHaveBeenCalled();
    },
  );
});
