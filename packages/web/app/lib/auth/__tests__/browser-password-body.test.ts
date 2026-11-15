// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import {
  readBrowserPasswordControl,
  readBrowserPasswordForm,
  readSettledPasswordBody,
} from '../browser-password-body.server';

describe('physical password body settlement', () => {
  it('retains password bytes while removing only public cursor metadata from the framework form', async () => {
    const password = '  unchanged\u0000密码  ';
    const form = new URLSearchParams({
      email: ' Mixed@Example.test ',
      password,
      csrfToken: 'actual-csrf',
      callbackUrl: '/',
      json: 'true',
      browserPasswordBindingId: 'a'.repeat(64),
      browserPasswordVersion: '7',
    });
    const result = await readBrowserPasswordForm(
      new Request('https://www.boardsesh.test/prepare', { method: 'POST', body: form }),
    );
    expect(result.password).toBe(password);
    expect(result.email).toBe(' Mixed@Example.test ');
    expect(result.metadata.cursor).toEqual({ bindingId: 'a'.repeat(64), version: 7 });
    expect(result.form.has('browserPasswordBindingId')).toBe(false);
    expect(result.form.has('browserPasswordVersion')).toBe(false);
    expect(result.form.get('password')).toBe(password);
  });
  it('rejects injected credential kind before installed framework invocation', async () => {
    const form = new URLSearchParams({
      email: 'account@example.test',
      password: 'actual',
      csrfToken: 'csrf',
      callbackUrl: '/',
      json: 'true',
      browserPasswordBindingId: 'a'.repeat(64),
      browserPasswordVersion: '7',
      credentialKind: 'canonical-token',
    });
    await expect(
      readBrowserPasswordForm(new Request('https://www.boardsesh.test/prepare', { method: 'POST', body: form })),
    ).rejects.toThrow();
  });
  it.each(['abort', 'oversize'] as const)('awaits held underlying cancellation after %s', async (fault) => {
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      cancelling = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        if (fault === 'oversize') source.enqueue(new Uint8Array(10));
      },
      cancel() {
        entered();
        return held;
      },
    });
    let settled = false;
    const result = readSettledPasswordBody(stream, controller.signal, 4).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    if (fault === 'abort') controller.abort();
    await cancelling;
    expect(settled).toBe(false);
    release();
    await result;
    expect(settled).toBe(true);
  });
  it('parses only complete bounded UTF-8 JSON control bodies', async () => {
    const input = { purpose: 'password-signin-recovery' };
    expect(
      await readBrowserPasswordControl(
        new Request('https://www.boardsesh.test/acknowledge', {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).toEqual(input);
    await expect(
      readBrowserPasswordControl(
        new Request('https://www.boardsesh.test/acknowledge', {
          method: 'POST',
          body: new Uint8Array([255]),
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).rejects.toThrow();
  });
});
