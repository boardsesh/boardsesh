import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import {
  EXPIRED_BROWSER_BINDING_BROWSER_PATHS,
  expiredBrowserBindingBrowserPreparationReplySchema,
} from '@boardsesh/auth-protocol/expired-browser-binding-browser-v1';
import { createExpiredBrowserBindingBrowserBroker } from '../expired-browser-binding-browser.server';
import type { ExpiredBrowserBindingCommandClient } from '../expired-browser-binding-command-client.server';
import type { BrowserBindingCommandClient } from '../browser-binding-command-client.server';
import type { PresentedBrowserSelection } from '../presented-browser-selection.server';
import {
  observedExpiredBrowserBindingOperationKeys,
  readExpiredBrowserBindingCarrier,
} from '../expired-browser-binding-carrier.server';
import { BROWSER_CORRELATION_COOKIE, readBrowserCorrelationCookie } from '../browser-proof-cookies.server';

const origin = 'https://www.owned-signin.example.test';
const secret = 'owned-public-expired-binding-cookie-secret-6975';
const token = (index: number) => Buffer.alloc(32, index).toString('base64url');
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
function applyCookies(header: string | null, response: Response): string {
  const pairs = new Map(
    (header ?? '')
      .split('; ')
      .filter(Boolean)
      .map((pair) => {
        const split = pair.indexOf('=');
        return [pair.slice(0, split), pair.slice(split + 1)] as const;
      }),
  );
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0];
    const split = pair.indexOf('=');
    const name = pair.slice(0, split),
      content = pair.slice(split + 1);
    if (!content) pairs.delete(name);
    else pairs.set(name, content);
  }
  return [...pairs].map(([name, content]) => `${name}=${content}`).join('; ');
}
function fixture() {
  const now = Date.now();
  const bindingToken = token(1),
    targetBindingToken = token(2),
    operationToken = token(3);
  const targetCursor = {
    bindingId: hash(targetBindingToken),
    version: 0,
    bindingExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
  };
  const preparation = {
    version: 1 as const,
    purpose: 'expired-browser-binding-retirement-v1' as const,
    oldBindingId: hash(bindingToken),
    oldVersion: 2,
    oldIntentRevision: 4,
    oldStateHash: 'c'.repeat(64),
    oldExpiresAt: new Date(now - 1_000).toISOString(),
    targetCursor,
    nonceHash: 'd'.repeat(64),
    authority: {
      projectionId: 'owned-projection',
      normalizerVersion: 'owned-normalizer',
      authority: 'current-store' as const,
      epoch: 1,
    },
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    acknowledgeUntil: new Date(now + 300_000).toISOString(),
  };
  const state = {
    completed: false,
    target: 'anonymous' as 'anonymous' | 'selected',
    version: 0,
    lostFinalize: false,
    ackUnavailable: false,
  };
  const envelope = { expiredBrowserBindingProtocolVersion: 1 as const, requestId: randomUUID() };
  const prepare = vi.fn<ExpiredBrowserBindingCommandClient['prepare']>(async (payload) => ({
    ...envelope,
    operation: 'prepare',
    outcome: 'prepared',
    operationToken,
    targetBindingToken,
    preparation: { ...preparation, nonceHash: payload.nonceHash },
  }));
  const finalize = vi.fn<ExpiredBrowserBindingCommandClient['finalize']>(async () => {
    if (state.completed) return { ...envelope, operation: 'finalize', outcome: 'conflict' };
    state.completed = true;
    if (state.lostFinalize) throw new Error('Private response lost: ' + targetBindingToken);
    return { ...envelope, operation: 'finalize', outcome: 'completed', cursor: targetCursor };
  });
  const acknowledge = vi.fn<ExpiredBrowserBindingCommandClient['acknowledge']>(async () => {
    if (state.ackUnavailable) return { ...envelope, operation: 'acknowledge', outcome: 'unavailable' };
    if (!state.completed || state.target !== 'anonymous' || state.version !== 0)
      return { ...envelope, operation: 'acknowledge', outcome: 'conflict' };
    return { ...envelope, operation: 'acknowledge', outcome: 'completed', cursor: targetCursor };
  });
  const read = vi.fn<BrowserBindingCommandClient['read']>(async () =>
    state.completed && state.target === 'anonymous'
      ? {
          browserBindingProtocolVersion: 1,
          requestId: randomUUID(),
          operation: 'read',
          outcome: 'anonymous',
          cursor: { ...targetCursor, version: state.version },
        }
      : { browserBindingProtocolVersion: 1, requestId: randomUUID(), operation: 'read', outcome: 'denied' },
  );
  const readSelection = vi.fn<(header: string | null) => Promise<PresentedBrowserSelection>>(async (header) => {
    const correlation = readBrowserCorrelationCookie(header);
    if (
      correlation.status === 'present' &&
      correlation.token === targetBindingToken &&
      state.completed &&
      state.target === 'anonymous'
    )
      return { status: 'anonymous', cursor: { ...targetCursor, version: state.version } };
    return { status: 'denied' };
  });
  const environment = {
    NEXTAUTH_URL: origin,
    NEXTAUTH_SECRET: secret,
    CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
    CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE: 'backend-staging',
  };
  const client = { prepare, finalize, acknowledge };
  const binding = { read } as unknown as BrowserBindingCommandClient;
  const options = {
    environment,
    ready: () => true,
    readSelection,
    clientFactory: () => client,
    bindingFactory: () => binding,
    rateLimit: () => false,
  };
  const broker = createExpiredBrowserBindingBrowserBroker(options);
  const header = `${BROWSER_CORRELATION_COOKIE}=${bindingToken}; ordinary=kept; __Host-boardsesh.proof.${'e'.repeat(64)}.5=unrelated-proof`;
  function request(
    operation: keyof typeof EXPIRED_BROWSER_BINDING_BROWSER_PATHS,
    cookieHeader: string | null,
    body: unknown = {},
    signal?: AbortSignal,
  ) {
    return new Request(origin + EXPIRED_BROWSER_BINDING_BROWSER_PATHS[operation], {
      method: 'POST',
      headers: {
        host: new URL(origin).host,
        origin,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  }
  async function prepared() {
    const response = await broker.prepare(request('prepare', header));
    expect(response.status).toBe(200);
    const control = expiredBrowserBindingBrowserPreparationReplySchema.parse(await response.json());
    if (control.status !== 'prepared') throw new Error('Owned browser preparation refused');
    const { status: _status, ...command } = control;
    return { response, control: command, cookies: applyCookies(header, response) };
  }
  return {
    options,
    broker,
    request,
    prepared,
    header,
    state,
    client,
    read,
    readSelection,
    preparation,
    bindingToken,
    targetBindingToken,
    operationToken,
  };
}

describe('explicit expired-browser-binding prepare/commit/confirm', () => {
  it('delivers encrypted actual custody before finalization and confirms physical anonymous target before cleanup', async () => {
    const test = fixture();
    const prepared = await test.prepared();
    expect(test.client.finalize).not.toHaveBeenCalled();
    expect(readBrowserCorrelationCookie(prepared.cookies)).toMatchObject({ token: test.bindingToken });
    const carrier = readExpiredBrowserBindingCarrier(prepared.cookies, prepared.control.operationKey, secret, origin);
    expect(carrier.targetBindingToken).toBe(test.targetBindingToken);
    expect(prepared.cookies).not.toContain(test.targetBindingToken);
    const committed = await test.broker.commit(test.request('commit', prepared.cookies, prepared.control));
    expect(committed.status).toBe(200);
    expect(test.client.finalize).toHaveBeenCalledTimes(1);
    const installed = applyCookies(prepared.cookies, committed);
    expect(readBrowserCorrelationCookie(installed)).toMatchObject({ token: test.targetBindingToken });
    expect(observedExpiredBrowserBindingOperationKeys(installed)).toEqual([prepared.control.operationKey]);
    const confirmed = await test.broker.confirm(test.request('confirm', installed, prepared.control));
    expect(confirmed.status).toBe(200);
    const finalCookies = applyCookies(installed, confirmed);
    expect(observedExpiredBrowserBindingOperationKeys(finalCookies)).toEqual([]);
    expect(finalCookies).toContain('ordinary=kept');
    expect(finalCookies).toContain('unrelated-proof');
    expect(readBrowserCorrelationCookie(finalCookies)).toMatchObject({ token: test.targetBindingToken });
    expect(await confirmed.json()).toEqual({ status: 'ready', cursor: prepared.control.targetCursor });
  });
  it('recovers a lost finalizer response only by durable ACK on a later explicit action', async () => {
    const test = fixture();
    const prepared = await test.prepared();
    test.state.lostFinalize = true;
    const unknown = await test.broker.commit(test.request('commit', prepared.cookies, prepared.control));
    expect(unknown.status).toBe(503);
    expect(unknown.headers.getSetCookie()).toEqual([]);
    expect(await unknown.text()).not.toContain(test.targetBindingToken);
    expect(test.client.finalize).toHaveBeenCalledTimes(1);
    const recovered = await test.broker.prepare(test.request('prepare', prepared.cookies));
    expect(recovered.status).toBe(200);
    expect(test.client.prepare).toHaveBeenCalledTimes(1);
    expect(test.client.finalize).toHaveBeenCalledTimes(1);
    expect(readBrowserCorrelationCookie(applyCookies(prepared.cookies, recovered))).toMatchObject({
      token: test.targetBindingToken,
    });
  });
  it('does not finalize an earlier uncompleted carrier during a later prepare', async () => {
    const test = fixture();
    const prepared = await test.prepared();
    // The test backend intentionally repeats its operation key; physical custody
    // cannot overwrite it. Production prepares generate a fresh private token.
    const later = await test.broker.prepare(test.request('prepare', prepared.cookies));
    expect(later.status).toBe(503);
    expect(test.client.finalize).not.toHaveBeenCalled();
    expect(test.client.prepare).toHaveBeenCalledTimes(2);
    expect(later.headers.getSetCookie()).toEqual([]);
  });
  it.each(['commit', 'confirm'] as const)(
    'refuses %s carrying an unrelated actual current correlation',
    async (operation) => {
      const test = fixture();
      const prepared = await test.prepared();
      const other = prepared.cookies.replace(
        `${BROWSER_CORRELATION_COOKIE}=${test.bindingToken}`,
        `${BROWSER_CORRELATION_COOKIE}=${token(9)}`,
      );
      const refused = await test.broker[operation](test.request(operation, other, prepared.control));
      expect(refused.status).toBe(409);
      expect(refused.headers.getSetCookie()).toEqual([]);
      expect(test.client.finalize).not.toHaveBeenCalled();
      expect(test.client.acknowledge).not.toHaveBeenCalled();
    },
  );
  it('does not confirm a target cookie without durable completion, even if independently anonymous', async () => {
    const test = fixture();
    const prepared = await test.prepared();
    const target = prepared.cookies.replace(
      `${BROWSER_CORRELATION_COOKIE}=${test.bindingToken}`,
      `${BROWSER_CORRELATION_COOKIE}=${test.targetBindingToken}`,
    );
    const refused = await test.broker.confirm(test.request('confirm', target, prepared.control));
    expect(refused.status).toBe(409);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(test.read).not.toHaveBeenCalled();
    expect(test.client.finalize).not.toHaveBeenCalled();
  });
  it.each(['selected', 'version'] as const)('cannot recover a later %s target', async (drift) => {
    const test = fixture();
    const prepared = await test.prepared();
    test.state.completed = true;
    if (drift === 'selected') test.state.target = 'selected';
    else test.state.version = 1;
    test.client.prepare.mockResolvedValue({
      expiredBrowserBindingProtocolVersion: 1,
      requestId: randomUUID(),
      operation: 'prepare',
      outcome: 'conflict',
    });
    const refused = await test.broker.prepare(test.request('prepare', prepared.cookies));
    expect(refused.status).toBe(409);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(test.client.finalize).not.toHaveBeenCalled();
  });
  it('rechecks durable completion after an awaited primary target read', async () => {
    const test = fixture();
    const prepared = await test.prepared();
    test.state.completed = true;
    test.read.mockImplementationOnce(async () => {
      test.state.ackUnavailable = true;
      return {
        browserBindingProtocolVersion: 1,
        requestId: randomUUID(),
        operation: 'read',
        outcome: 'anonymous',
        cursor: test.preparation.targetCursor,
      };
    });
    const target = prepared.cookies.replace(
      `${BROWSER_CORRELATION_COOKIE}=${test.bindingToken}`,
      `${BROWSER_CORRELATION_COOKIE}=${test.targetBindingToken}`,
    );
    const refused = await test.broker.confirm(test.request('confirm', target, prepared.control));
    expect(refused.status).toBe(503);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(test.client.acknowledge).toHaveBeenCalledTimes(2);
  });
  it('keeps a live admitted or anonymous binding instead of invoking expiry retirement', async () => {
    const test = fixture();
    test.readSelection.mockResolvedValue({
      status: 'anonymous',
      cursor: { ...test.preparation.targetCursor, bindingId: hash(test.bindingToken), version: 2 },
    });
    const current = await test.broker.prepare(test.request('prepare', test.header));
    expect(current.status).toBe(200);
    expect(current.headers.getSetCookie()).toEqual([]);
    expect(test.readSelection).toHaveBeenCalledTimes(2);
    expect(test.client.prepare).not.toHaveBeenCalled();
  });
  it('does not publish a ready body after its actual selected frame changes', async () => {
    const test = fixture();
    test.readSelection
      .mockResolvedValueOnce({
        status: 'anonymous',
        cursor: { ...test.preparation.targetCursor, bindingId: hash(test.bindingToken), version: 2 },
      })
      .mockResolvedValueOnce({ status: 'conflict' });
    const refused = await test.broker.prepare(test.request('prepare', test.header));
    expect(refused.status).toBe(409);
    expect(refused.headers.getSetCookie()).toEqual([]);
  });
  it('does not replace live selected missing proof when the private expiry check refuses', async () => {
    const test = fixture();
    test.readSelection.mockResolvedValue({ status: 'proof-required' });
    test.client.prepare.mockResolvedValue({
      expiredBrowserBindingProtocolVersion: 1,
      requestId: randomUUID(),
      operation: 'prepare',
      outcome: 'denied',
    });
    const refused = await test.broker.prepare(test.request('prepare', test.header));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ status: 'proof-required' });
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(test.client.finalize).not.toHaveBeenCalled();
  });
  it('holds unavailable primary state without creating a new operation', async () => {
    const test = fixture();
    test.readSelection.mockResolvedValue({ status: 'unavailable' });
    const refused = await test.broker.prepare(test.request('prepare', test.header));
    expect(refused.status).toBe(503);
    expect(test.client.prepare).not.toHaveBeenCalled();
  });
  it('prepares all target-cookie capacity before finalizing', async () => {
    const test = fixture();
    const prepared = await test.prepared();
    const oversize = prepared.cookies + '; extra=' + 'x'.repeat(8_000);
    const refused = await test.broker.commit(test.request('commit', oversize, prepared.control));
    expect(refused.status).toBe(503);
    expect(test.client.finalize).not.toHaveBeenCalled();
    expect(refused.headers.getSetCookie()).toEqual([]);
  });
  it('does not issue custody when the whole observed pair count has no room', async () => {
    const test = fixture();
    const full =
      `${BROWSER_CORRELATION_COOKIE}=${test.bindingToken}; ` +
      Array.from({ length: 127 }, () => 'duplicate=kept').join('; ');
    const refused = await test.broker.prepare(test.request('prepare', full));
    expect(refused.status).toBe(503);
    expect(test.client.prepare).not.toHaveBeenCalled();
    expect(refused.headers.getSetCookie()).toEqual([]);
  });
  it('never publishes cookies after cancellation during the private finalizer', async () => {
    const test = fixture();
    const prepared = await test.prepared();
    const controller = new AbortController();
    test.client.finalize.mockImplementationOnce(async () => {
      test.state.completed = true;
      controller.abort();
      return {
        expiredBrowserBindingProtocolVersion: 1,
        requestId: randomUUID(),
        operation: 'finalize',
        outcome: 'completed',
        cursor: test.preparation.targetCursor,
      };
    });
    const refused = await test.broker.commit(
      test.request('commit', prepared.cookies, prepared.control, controller.signal),
    );
    expect(refused.status).toBe(503);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(test.client.finalize).toHaveBeenCalledTimes(1);
  });
  it.each(['binding', 'nonce', 'deadline'] as const)(
    'does not issue a private preparation with mismatched %s',
    async (drift) => {
      const test = fixture();
      test.client.prepare.mockImplementationOnce(async (payload) => ({
        expiredBrowserBindingProtocolVersion: 1,
        requestId: randomUUID(),
        operation: 'prepare',
        outcome: 'prepared',
        operationToken: test.operationToken,
        targetBindingToken: test.targetBindingToken,
        preparation: {
          ...test.preparation,
          nonceHash: drift === 'nonce' ? 'f'.repeat(64) : payload.nonceHash,
          ...(drift === 'binding' ? { oldBindingId: 'a'.repeat(64) } : {}),
          ...(drift === 'deadline' ? { expiresAt: new Date(Date.now() - 1).toISOString() } : {}),
        },
      }));
      const refused = await test.broker.prepare(test.request('prepare', test.header));
      expect(refused.status).toBe(503);
      expect(refused.headers.getSetCookie()).toEqual([]);
    },
  );
  it.each([
    'disabled',
    'legacy-binding',
    'legacy-expired',
    'host',
    'origin',
    'cross-site',
    'query',
    'method',
    'body',
    'correlation',
    'rate-limit',
  ] as const)('refuses %s before the private writer', async (failure) => {
    const test = fixture();
    const environment = {
      ...test.options.environment,
      ...(failure === 'legacy-binding' ? { CURRENT_STORE_BROWSER_BINDING_MODE: 'legacy' } : {}),
      ...(failure === 'legacy-expired' ? { CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE: 'legacy' } : {}),
    };
    const broker = createExpiredBrowserBindingBrowserBroker({
      ...test.options,
      environment,
      ...(failure === 'disabled' ? { ready: () => false } : {}),
      rateLimit: () => failure === 'rate-limit',
    });
    const request = test.request(
      'prepare',
      failure === 'correlation' ? null : test.header,
      failure === 'body' ? { userId: 'caller' } : {},
    );
    if (failure === 'host') request.headers.set('host', 'attacker.example.test');
    if (failure === 'origin') request.headers.set('origin', 'https://app.owned-signin.example.test');
    if (failure === 'cross-site') request.headers.set('sec-fetch-site', 'cross-site');
    const changed =
      failure === 'query'
        ? new Request(request.url + '?override=1', request)
        : failure === 'method'
          ? new Request(request.url, { method: 'GET', headers: request.headers })
          : request;
    const refused = await broker.prepare(changed);
    expect(refused.status).not.toBe(200);
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect(test.client.prepare).not.toHaveBeenCalled();
    expect(test.client.finalize).not.toHaveBeenCalled();
  });
  it('censors unexpected private transport failures and raw capability text', async () => {
    const test = fixture();
    test.client.prepare.mockRejectedValue(new Error(test.bindingToken + test.targetBindingToken));
    const refused = await test.broker.prepare(test.request('prepare', test.header));
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe('{"status":"unavailable"}');
    expect(refused.headers.getSetCookie()).toEqual([]);
  });
});
