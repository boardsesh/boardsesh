// @vitest-environment node
import { describe, it, expect, vi } from 'vite-plus/test';
import type { NextAuthOptions } from 'next-auth';
import { BROWSER_PASSWORD_BROWSER_PATHS } from '@boardsesh/auth-protocol/browser-password-browser-v1';
import type { BrowserPasswordReply } from '@boardsesh/auth-protocol/browser-password-v1';
vi.mock('server-only', () => ({}));
import { createBrowserPasswordHandler } from '../browser-password-browser.server';
import {
  BROWSER_CORRELATION_COOKIE,
  buildBrowserProofCookieCandidate,
  readBrowserProofCookie,
} from '../browser-proof-cookies.server';
import { createBrowserPasswordAuthPreparation } from '../browser-password-auth.server';
import {
  browserPasswordCandidateHash,
  type BrowserPasswordCommandClient,
} from '../browser-password-command-client.server';
import {
  browserPasswordCustodySchema,
  sealBrowserPasswordCustody,
  buildBrowserPasswordCustodyCookies,
  observedBrowserPasswordOperationKeys,
} from '../browser-password-custody.server';
import { browserPasswordFixture, passwordTestEnvironment, passwordTestSelection } from './fixtures/browser-password';
const origin = passwordTestEnvironment.NEXTAUTH_URL;
function fixture(selected = true) {
  const current = browserPasswordFixture('canonical-token', selected);
  const trace: string[] = [];
  let completed = false;
  let header = `${BROWSER_CORRELATION_COOKIE}=${current.source.bindingToken}`;
  if (current.source.state === 'selected')
    header +=
      '; ' +
      buildBrowserProofCookieCandidate({
        cursor: {
          bindingId: current.preparation.browserCursor.bindingId,
          version: current.preparation.browserCursor.version,
        },
        proof: {
          kind: 'canonical-token',
          rawCredential:
            current.source.actor.credential.kind === 'canonical-token' ? current.source.actor.credential.token : '',
        },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: null,
        retainObservedProofCookies: true,
      })
        .headers.map((item) => item.split(';', 1)[0])
        .join('; ');
  const prepared = {
    browserPasswordProtocolVersion: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000001',
    operation: 'prepare' as const,
    outcome: 'prepared' as const,
    ...current,
  };
  const completion = (): Extract<BrowserPasswordReply, { outcome: 'completed' }> => ({
    browserPasswordProtocolVersion: 1,
    requestId: prepared.requestId,
    operation: 'finalize',
    outcome: 'completed',
    cursor: current.preparation.futureBrowserCursor,
    credentialProof: current.preparation.credentialProof,
    credentialExpiresAt: current.preparation.credentialExpiresAt,
    candidateCredentialHash: browserPasswordCandidateHash(current.candidate),
  });
  const client: BrowserPasswordCommandClient = {
    prepare: vi.fn(async () => prepared),
    finalize: vi.fn(async () => {
      trace.push('finalize');
      completed = true;
      return { ...completion(), operation: 'finalize' as const };
    }),
    acknowledge: vi.fn(async (payload) => {
      trace.push('ack');
      return completed && payload.preparation.nonceHash === current.preparation.nonceHash
        ? { ...completion(), operation: 'acknowledge' as const }
        : {
            browserPasswordProtocolVersion: 1 as const,
            requestId: prepared.requestId,
            operation: 'acknowledge' as const,
            outcome: 'conflict' as const,
          };
    }),
    abort: vi.fn(async () => ({
      browserPasswordProtocolVersion: 1 as const,
      requestId: prepared.requestId,
      operation: 'abort' as const,
      outcome: 'aborted' as const,
    })),
  };
  const readSelection = vi.fn(async (cookie: string | null) => {
    trace.push('observe');
    if (!completed) return passwordTestSelection(current);
    const proof = readBrowserProofCookie(cookie, {
      bindingId: current.preparation.futureBrowserCursor.bindingId,
      version: 8,
    });
    if (proof.status !== 'present' || proof.proof.rawCredential !== current.proposedCanonicalToken)
      return { status: 'proof-required' as const };
    return passwordTestSelection(current, true);
  });
  const accepted = vi.fn();
  const prepareAuth = vi.fn((_base, _request, _input, settings) => ({
    abort: async () => {
      await client.abort({
        source: current.source,
        operationToken: current.operationToken,
        browserIntentToken: current.browserIntentToken,
        preparation: current.preparation,
      });
    },
    run: async () => {
      settings.passwordAccepted();
      return { status: 'prepared' as const, prepared, candidate: current.candidate, destination: `${origin}/settings` };
    },
    options: {} as NextAuthOptions,
  })) as typeof createBrowserPasswordAuthPreparation;
  const admission = vi.fn(() => ({ limitedResponse: null, passwordAccepted: accepted }));
  const options = {
    environment: passwordTestEnvironment,
    ready: () => true,
    client,
    readSelection,
    prepareAuth,
    authOptions: () => ({}) as NextAuthOptions,
    admission,
    operationKey: () => current.preparation.nonceHash,
  };
  const request = (operation: keyof typeof BROWSER_PASSWORD_BROWSER_PATHS, body: unknown, observed = header) =>
    new Request(origin + BROWSER_PASSWORD_BROWSER_PATHS[operation], {
      method: 'POST',
      headers: {
        host: new URL(origin).host,
        origin,
        'sec-fetch-site': 'same-origin',
        cookie: observed,
        'content-type': operation === 'prepare' ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body:
        operation === 'prepare'
          ? new URLSearchParams({
              email: 'exact@example.test',
              password: 'exact password',
              csrfToken: 'real-csrf',
              callbackUrl: origin + '/settings',
              json: 'true',
              browserPasswordBindingId: current.preparation.browserCursor.bindingId,
              browserPasswordVersion: '7',
            })
          : JSON.stringify(body),
    });
  const invoke = (operation: keyof typeof BROWSER_PASSWORD_BROWSER_PATHS, body: unknown = {}, observed = header) =>
    createBrowserPasswordHandler(operation, options)(request(operation, body, observed));
  const remember = (response: Response) => {
    const cookies = new Map(
      header.split(';').map((pair) => {
        const separator = pair.indexOf('=');
        return [pair.slice(0, separator).trim(), pair.slice(separator + 1)];
      }),
    );
    for (const written of response.headers.getSetCookie()) {
      const pair = written.split(';', 1)[0],
        separator = pair.indexOf('=');
      if (written.includes('Max-Age=0')) cookies.delete(pair.slice(0, separator));
      else cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    header = [...cookies].map(([name, content]) => name + '=' + content).join('; ');
  };
  const control = (target = false) => ({
    operationKey: current.preparation.nonceHash,
    cursor: { bindingId: current.preparation.browserCursor.bindingId, version: target ? 8 : 7 },
  });
  return {
    current,
    client,
    trace,
    readSelection,
    prepareAuth,
    admission,
    accepted,
    options,
    request,
    invoke,
    remember,
    control,
    get header() {
      return header;
    },
    setCompleted: () => {
      completed = true;
    },
  };
}
describe('mounted canonical password physical response transaction', () => {
  it.each([true, false])('first response publishes only recoverable custody, selected=%s', async (selected) => {
    const current = fixture(selected);
    const response = await current.invoke('prepare');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'prepared' });
    expect(response.headers.getSetCookie().every((item) => item.startsWith('__Host-boardsesh.password-signin.'))).toBe(
      true,
    );
    expect(response.headers.getSetCookie().join()).not.toContain(current.current.proposedCanonicalToken);
    expect(current.client.finalize).not.toHaveBeenCalled();
    expect(current.admission).toHaveBeenCalledOnce();
    expect(current.accepted).toHaveBeenCalledOnce();
  });
  it('commits exactly once after prebuffer, then primary read settles before final ACK', async () => {
    const current = fixture();
    current.remember(await current.invoke('prepare'));
    current.trace.length = 0;
    const response = await current.invoke('commit', current.control());
    expect(response.status).toBe(200);
    expect(current.trace).toEqual(['observe', 'finalize', 'observe', 'ack']);
    expect(current.client.finalize).toHaveBeenCalledOnce();
    expect(current.client.prepare).not.toHaveBeenCalled();
    expect(current.client.abort).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie().every((item) => item.startsWith('__Host-boardsesh.browser-proof.'))).toBe(
      true,
    );
    current.remember(response);
    const confirmed = await current.invoke('confirm', current.control(true));
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ status: 'confirmed', url: origin + '/settings' });
    expect(
      confirmed.headers
        .getSetCookie()
        .every((item) => item.startsWith('__Host-boardsesh.password-signin.') && item.includes('Max-Age=0')),
    ).toBe(true);
  });
  it('recovers lost finalize response ACK-only BEFORE any source observation', async () => {
    const current = fixture();
    current.remember(await current.invoke('prepare'));
    const oldHeader = current.header;
    const lost = await current.invoke('commit', current.control());
    expect(lost.status).toBe(200);
    current.trace.length = 0;
    const recovered = await current.invoke('acknowledge', { purpose: 'password-signin-recovery' }, oldHeader);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: 'recovered' });
    expect(current.trace).toEqual(['ack', 'observe', 'ack']);
    expect(current.client.finalize).toHaveBeenCalledOnce();
    expect(current.client.prepare).not.toHaveBeenCalled();
    current.remember(recovered);
    expect((await current.invoke('confirm', current.control(true))).status).toBe(200);
  });
  it('skips an earlier pending custody and recovers a later exact completion', async () => {
    const current = fixture();
    current.remember(await current.invoke('prepare'));
    current.setCompleted();
    const pending = browserPasswordFixture('canonical-token', false);
    pending.preparation.nonceHash = 'a'.repeat(64);
    const custody = browserPasswordCustodySchema.parse({
      version: 1,
      purpose: 'boardsesh-browser-password-candidate-custody-v1',
      operationKey: pending.preparation.nonceHash,
      canonicalOrigin: origin,
      source: pending.source,
      operationToken: pending.operationToken,
      browserIntentToken: pending.browserIntentToken,
      preparation: pending.preparation,
      candidate: pending.candidate,
      destination: origin + '/settings',
    });
    const prefix = buildBrowserPasswordCustodyCookies(
      custody,
      sealBrowserPasswordCustody(custody, passwordTestEnvironment.NEXTAUTH_SECRET),
      null,
    )
      .map((item) => item.split(';', 1)[0])
      .join('; ');
    const response = await current.invoke(
      'acknowledge',
      { purpose: 'password-signin-recovery' },
      prefix + '; ' + current.header,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'recovered' });
    expect(current.trace.slice(-4)).toEqual(['ack', 'ack', 'observe', 'ack']);
  });
  it.each(['cursor', 'capacity', 'source-proof', 'correlation', 'deadline'] as const)(
    'refuses %s before finalizer',
    async (fault) => {
      const current = fixture();
      current.remember(await current.invoke('prepare'));
      let header = current.header;
      const control = current.control();
      if (fault === 'cursor') control.cursor.version = 6;
      if (fault === 'capacity') header += '; padding=' + 'a'.repeat(8192);
      if (fault === 'source-proof') current.readSelection.mockResolvedValue({ status: 'proof-required' });
      if (fault === 'correlation') header = header.replace(current.current.source.bindingToken, 'A'.repeat(43));
      if (fault === 'deadline')
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(current.current.preparation.expiresAt));
      try {
        const response = await current.invoke('commit', control, header);
        expect(response.status).not.toBe(200);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(current.client.finalize).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
  it.each(['candidate-hash', 'generation', 'cursor', 'expiry'] as const)(
    'quarantines changed completed %s without ACK or retries',
    async (fault) => {
      const current = fixture();
      current.remember(await current.invoke('prepare'));
      const finalize = current.client.finalize;
      const original = vi.mocked(finalize).getMockImplementation()!;
      vi.mocked(finalize).mockImplementation(async (payload) => {
        const reply = await original(payload);
        if (reply.outcome !== 'completed') throw new Error('Expected completion');
        if (fault === 'candidate-hash') reply.candidateCredentialHash = '0'.repeat(64);
        if (fault === 'generation') reply.credentialProof = { ...reply.credentialProof, generation: 99 };
        if (fault === 'cursor') reply.cursor = { ...reply.cursor, version: 99 };
        if (fault === 'expiry') reply.credentialExpiresAt = '2030-01-01T00:00:00.000Z';
        return reply;
      });
      const response = await current.invoke('commit', current.control());
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(finalize).toHaveBeenCalledOnce();
      expect(current.client.acknowledge).not.toHaveBeenCalled();
      expect(current.client.abort).not.toHaveBeenCalled();
    },
  );
  it('requires delivered actual target proof for confirm and never re-finalizes a duplicate commit', async () => {
    const current = fixture();
    current.remember(await current.invoke('prepare'));
    expect((await current.invoke('commit', current.control())).status).toBe(200);
    expect((await current.invoke('confirm', current.control(true))).status).toBe(503);
    expect((await current.invoke('commit', current.control())).status).toBe(503);
    expect(current.client.finalize).toHaveBeenCalledOnce();
  });
  it('returns no cookies if final ACK denies after a held target primary read', async () => {
    const current = fixture();
    current.remember(await current.invoke('prepare'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = current.readSelection.getMockImplementation()!;
    let calls = 0;
    current.readSelection.mockImplementation(async (header) => {
      calls++;
      if (calls === 2) await gate;
      return original(header);
    });
    const running = current.invoke('commit', current.control());
    await vi.waitFor(() => expect(current.client.finalize).toHaveBeenCalledOnce());
    expect(current.client.acknowledge).not.toHaveBeenCalled();
    vi.mocked(current.client.acknowledge).mockResolvedValue({
      browserPasswordProtocolVersion: 1,
      requestId: '00000000-0000-4000-8000-000000000001',
      operation: 'acknowledge',
      outcome: 'denied',
    });
    release();
    const response = await running;
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(current.client.finalize).toHaveBeenCalledOnce();
    expect(current.client.abort).not.toHaveBeenCalled();
  });
  it.each(['ready', 'host', 'origin', 'metadata'] as const)(
    'fails closed at the %s boundary without password work',
    async (fault) => {
      const current = fixture();
      const request = current.request('prepare', {});
      if (fault === 'host') request.headers.set('host', 'foreign.test');
      if (fault === 'origin') request.headers.set('origin', 'https://foreign.test');
      const response = await createBrowserPasswordHandler('prepare', {
        ...current.options,
        ...(fault === 'ready' ? { ready: () => false } : {}),
      })(fault === 'metadata' ? current.request('commit', { password: 'forbidden' }) : request);
      expect(response.status).not.toBe(200);
      expect(current.prepareAuth).not.toHaveBeenCalled();
      expect(current.client.finalize).not.toHaveBeenCalled();
    },
  );
  it('completed recovery remains available after original source and prepare deadline', async () => {
    const current = fixture();
    const oldSourceExpiry = new Date(Date.now() + 10_000).toISOString();
    if (current.current.preparation.source.state !== 'selected') throw new Error('Expected source');
    current.current.preparation.source.expiresAt = oldSourceExpiry;
    current.current.preparation.expiresAt = oldSourceExpiry;
    current.remember(await current.invoke('prepare'));
    current.setCompleted();
    const future = Date.parse(oldSourceExpiry) + 1;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      const response = await current.invoke('acknowledge', { purpose: 'password-signin-recovery' });
      expect(response.status).toBe(200);
      expect(current.trace.slice(-3)).toEqual(['ack', 'observe', 'ack']);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each(['primary', 'ack'] as const)(
    'publishes no cookies when the fixed ACK deadline passes during %s',
    async (phase) => {
      const current = fixture();
      current.remember(await current.invoke('prepare'));
      const afterDeadline = () =>
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(current.current.preparation.acknowledgeUntil));
      if (phase === 'primary') {
        const original = current.readSelection.getMockImplementation()!;
        let observations = 0;
        current.readSelection.mockImplementation(async (header) => {
          const selected = await original(header);
          if (++observations === 2) afterDeadline();
          return selected;
        });
      } else {
        const original = vi.mocked(current.client.acknowledge).getMockImplementation()!;
        vi.mocked(current.client.acknowledge).mockImplementation(async (payload) => {
          const reply = await original(payload);
          afterDeadline();
          return reply;
        });
      }
      try {
        const response = await current.invoke('commit', current.control());
        expect(response.status).toBe(503);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(current.client.finalize).toHaveBeenCalledOnce();
        expect(current.client.abort).not.toHaveBeenCalled();
        if (phase === 'primary') expect(current.client.acknowledge).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
  it('confirmation cleanup preserves old proof and unrelated cookies', async () => {
    const current = fixture();
    const original = current.header;
    current.remember(await current.invoke('prepare'));
    const committed = await current.invoke('commit', current.control());
    current.remember(committed);
    const confirmation = await current.invoke('confirm', current.control(true));
    current.remember(confirmation);
    expect(observedBrowserPasswordOperationKeys(current.header)).toEqual([]);
    for (const pair of original.split('; ')) expect(current.header).toContain(pair);
  });
});
