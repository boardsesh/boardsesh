// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';
import { decode, encode } from 'next-auth/jwt';
vi.mock('server-only', () => ({}));
import {
  BROWSER_CORRELATION_COOKIE,
  BROWSER_CORRELATION_LEASE_SECONDS,
  BROWSER_PROOF_COOKIE_LIMITS,
  browserProofCookieName,
  buildBrowserProofCookieCandidate,
  buildCanonicalCoordinatorCorrelationCookie,
  buildObservedOlderBrowserProofCookieClears,
  readBrowserCorrelationCookie,
  readBrowserProofCookie,
  type BrowserCookieSourceProof,
} from '../browser-proof-cookies.server';
const cursor = { bindingId: 'a'.repeat(64), version: 2 };
const source: BrowserCookieSourceProof = { kind: 'canonical-token', rawCredential: 'owned-opaque-session-token' };
const pair = (header: string) => header.split(';', 1)[0];
const proofHeader = (proof = source, selected = cursor) =>
  buildBrowserProofCookieCandidate({ cursor: selected, proof, proofMaxAgeSeconds: 3600, observedCookieHeader: null })
    .proofHeaders.map(pair)
    .join('; ');
const envelope = (input: unknown) => Buffer.from(JSON.stringify(input)).toString('base64url');
const base = browserProofCookieName(cursor);

describe('unmounted canonical-www proof cookie codec', () => {
  it('roundtrips the exact actual public NextAuth JWE without making an identity claim', async () => {
    const secret = 'owned-cookie-codec-secret';
    const rawCredential = await encode({
      secret,
      token: { sub: 'owned-user', authSessionId: 'owned-login', gen: 3, auth_time: 100 },
    });
    const result = readBrowserProofCookie(proofHeader({ kind: 'legacy-jwe', rawCredential }), cursor);
    expect(result).toEqual({ status: 'present', proof: { kind: 'legacy-jwe', rawCredential } });
    expect(await decode({ secret, token: rawCredential })).toMatchObject({
      sub: 'owned-user',
      authSessionId: 'owned-login',
      gen: 3,
      auth_time: 100,
    });
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'preserves a chunked %s source exactly and sorts only its exact chunk family',
    (kind) => {
      const rawCredential = 'owned-'.repeat(600);
      const candidate = buildBrowserProofCookieCandidate({
        cursor,
        proof: { kind, rawCredential },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: null,
      });
      expect(candidate.proofHeaders.length).toBeGreaterThan(1);
      expect(readBrowserProofCookie([...candidate.proofHeaders].reverse().map(pair).join('; '), cursor)).toEqual({
        status: 'present',
        proof: { kind, rawCredential },
      });
      for (const header of candidate.proofHeaders) {
        expect(header).toContain('; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600');
        expect(header).not.toMatch(/Domain=|Expires=/);
        expect(Buffer.byteLength(header)).toBeLessThanOrEqual(4096);
      }
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.headers)).toBe(true);
      expect(Object.isFrozen(candidate.cursor)).toBe(true);
    },
  );
  it('selects only the primary backend cursor despite older, future and foreign valid cookies', () => {
    const older = proofHeader({ kind: 'canonical-token', rawCredential: 'older' }, { ...cursor, version: 1 });
    const future = proofHeader({ kind: 'canonical-token', rawCredential: 'future' }, { ...cursor, version: 999 });
    const foreign = proofHeader(
      { kind: 'canonical-token', rawCredential: 'foreign' },
      { bindingId: 'b'.repeat(64), version: 2 },
    );
    expect(readBrowserProofCookie([older, future, foreign, proofHeader()].join('; '), cursor)).toEqual({
      status: 'present',
      proof: source,
    });
    expect(readBrowserProofCookie([older, future, foreign].join('; '), cursor)).toEqual({ status: 'missing' });
  });
  it('never turns a known correlation pointer or a legacy cookie into a proof', () => {
    expect(
      readBrowserProofCookie(
        `${BROWSER_CORRELATION_COOKIE}=${randomBytes(32).toString('base64url')}; next-auth.session-token=not-current-proof`,
        cursor,
      ),
    ).toEqual({ status: 'missing' });
  });
  it.each([
    `${base}=same; ${base}=same`,
    `${base}.0=a; ${base}.0=b`,
    `${base}=a; ${base}.0=b`,
    `${base}.0=a; ${base}.2=b`,
    `${base}.1=a`,
    `${base}.00=a`,
    `${base}.0=a; ${base}.8=b`,
    `${base}=`,
  ])('refuses an ambiguous/duplicate/gapped current family (%s)', (header) =>
    expect(readBrowserProofCookie(header, cursor)).toEqual({ status: 'invalid' }),
  );
  it.each([
    { version: 2, kind: 'canonical-token', credential: 'source' },
    { version: 1, kind: 'unknown', credential: 'source' },
    { version: 1, kind: 'canonical-token', credential: 'source', secret: 'must-not-cross' },
    { version: 1, kind: 'canonical-token', credential: '' },
    { kind: 'canonical-token', version: 1, credential: 'source' },
    { version: 1, kind: 'canonical-token', credential: ' leading-space' },
  ])('refuses a malformed or noncanonical strict envelope (%j)', (input) =>
    expect(readBrowserProofCookie(`${base}=${envelope(input)}`, cursor)).toEqual({ status: 'invalid' }),
  );
  it('refuses duplicate JSON keys even when JSON.parse would keep a valid last key', () => {
    const duplicate = '{"version":1,"kind":"legacy-jwe","kind":"canonical-token","credential":"source"}';
    expect(readBrowserProofCookie(`${base}=${Buffer.from(duplicate).toString('base64url')}`, cursor)).toEqual({
      status: 'invalid',
    });
  });
  it.each(['abc=', 'abc!', '%61bc', 'Zh'])('refuses noncanonical base64url %s', (content) =>
    expect(readBrowserProofCookie(`${base}=${content}`, cursor)).toEqual({ status: 'invalid' }),
  );
  it('rejects bounded header, pair and selected-value overflow without falling back', () => {
    expect(readBrowserProofCookie('x'.repeat(BROWSER_PROOF_COOKIE_LIMITS.incomingHeaderBytes + 1), cursor)).toEqual({
      status: 'invalid',
    });
    expect(readBrowserProofCookie(Array(130).fill('unrelated=a').join('; '), cursor)).toEqual({ status: 'invalid' });
    expect(readBrowserProofCookie(`${base}=${'a'.repeat(3001)}`, cursor)).toEqual({ status: 'invalid' });
    expect(readBrowserProofCookie(`${base}=abc\r\nInjected: yes`, cursor)).toEqual({ status: 'invalid' });
  });
  it('clears only exact observed older names/chunks for the same binding', () => {
    const old = browserProofCookieName({ ...cursor, version: 1 });
    const future = browserProofCookieName({ ...cursor, version: 3 });
    const foreign = browserProofCookieName({ bindingId: 'b'.repeat(64), version: 0 });
    const observed = [
      `${old}=a`,
      `${old}.0=b`,
      `${old}.2=c`,
      `${base}=current`,
      `${future}.0=future`,
      `${foreign}=foreign`,
      `${BROWSER_CORRELATION_COOKIE}=pointer`,
      `${old}.unknown=ignore`,
    ].join('; ');
    const clears = buildObservedOlderBrowserProofCookieClears(cursor, observed);
    expect(clears.map(pair)).toEqual([`${old}=`, `${old}.0=`, `${old}.2=`]);
    expect(clears.every((header) => header.endsWith('; Max-Age=0'))).toBe(true);
    expect(clears.join('\n')).not.toContain(BROWSER_CORRELATION_COOKIE + '=');
    expect(buildObservedOlderBrowserProofCookieClears({ ...cursor, version: 1 }, `${base}=future`)).toEqual([]);
  });
  it('bounds GC and never invents unobserved chunk deletions', () => {
    const observed = Array.from(
      { length: 20 },
      (_, version) => `${browserProofCookieName({ ...cursor, version })}=old`,
    ).join('; ');
    const clears = buildObservedOlderBrowserProofCookieClears({ ...cursor, version: 30 }, observed);
    expect(clears).toHaveLength(16);
    expect(clears.map(pair)).toEqual(
      observed
        .split('; ')
        .slice(0, 16)
        .map((cookie) => `${cookie.slice(0, cookie.indexOf('='))}=`),
    );
  });
  it('builds proof candidates without any correlation-cookie emission', () => {
    const candidate = buildBrowserProofCookieCandidate({
      cursor,
      proof: source,
      proofMaxAgeSeconds: 3600,
      observedCookieHeader: proofHeader(source, { ...cursor, version: 1 }),
    });
    expect(candidate.garbageCollectionHeaders).toHaveLength(1);
    expect(candidate.headers.join('\n')).not.toContain(BROWSER_CORRELATION_COOKIE + '=');
  });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    'retains the exact observed older %s actor proof and operation carrier for later ACK',
    (kind) => {
      const previous = { ...cursor, version: cursor.version - 1 };
      const actor = { kind, rawCredential: 'actual-original-actor-credential' };
      const oldProof = proofHeader(actor, previous);
      const operation = '__Host-boardsesh.provider-security.owned=actual-sealed-operation';
      const observed = `${oldProof}; ${operation}`;
      const candidate = buildBrowserProofCookieCandidate({
        cursor,
        proof: source,
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: observed,
        retainObservedProofCookies: true,
      });
      expect(candidate.garbageCollectionHeaders).toEqual([]);
      expect(candidate.headers).toEqual(candidate.proofHeaders);
      const nextRequest = `${observed}; ${candidate.proofHeaders.map(pair).join('; ')}`;
      expect(readBrowserProofCookie(nextRequest, previous)).toEqual({ status: 'present', proof: actor });
      expect(readBrowserProofCookie(nextRequest, cursor)).toEqual({ status: 'present', proof: source });
      expect(candidate.projectedCookieHeaderBytes).toBe(Buffer.byteLength(nextRequest));
      expect(candidate.headers.join('\n')).not.toContain('Max-Age=0');
      expect(nextRequest).toContain(operation);
    },
  );
  it('budgets every retained old proof and operation cookie from the actual observed header', () => {
    const proof = { ...source, rawCredential: 'a'.repeat(4200) };
    const observed = `${proofHeader(proof, { ...cursor, version: 1 })}; __Host-boardsesh.provider-security.owned=sealed-operation`;
    const input = { cursor, proof, proofMaxAgeSeconds: 3600, observedCookieHeader: observed };
    expect(buildBrowserProofCookieCandidate(input).projectedCookieHeaderBytes).toBeLessThan(8192);
    expect(() => buildBrowserProofCookieCandidate({ ...input, retainObservedProofCookies: true })).toThrow(
      'COOKIE_BUDGET',
    );
  });
  it('still refuses a same-version chunk-layout change while retaining older source material', () => {
    expect(() =>
      buildBrowserProofCookieCandidate({
        cursor,
        proof: { ...source, rawCredential: 'a'.repeat(4000) },
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: proofHeader(),
        retainObservedProofCookies: true,
      }),
    ).toThrow('INVALID_FAMILY');
  });
  it.each([null, 'true', 1, {}, []])('refuses a malformed trusted retention selector %j', (selection) => {
    expect(() =>
      buildBrowserProofCookieCandidate({
        cursor,
        proof: source,
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: null,
        retainObservedProofCookies: selection as unknown as boolean,
      }),
    ).toThrow('INVALID_SOURCE');
  });
  it.each(['raw-size', 'header-budget', 'request-budget', 'unrelated-cookies', 'chunk-layout', 'ttl'] as const)(
    'fails the entire candidate before a mutation is attempted: %s',
    (failure) => {
      const mutate = vi.fn();
      const input = {
        cursor,
        proof: source,
        proofMaxAgeSeconds: 3600,
        observedCookieHeader: null as string | null,
        responseHeaderBudgetBytes: 32768,
      };
      if (failure === 'raw-size') input.proof = { ...source, rawCredential: 'a'.repeat(16385) };
      if (failure === 'header-budget') input.responseHeaderBudgetBytes = 1;
      if (failure === 'request-budget') input.proof = { ...source, rawCredential: 'a'.repeat(7000) };
      if (failure === 'unrelated-cookies')
        input.observedCookieHeader = `analyticsA=${'x'.repeat(4000)}; analyticsB=${'x'.repeat(4000)}`;
      if (failure === 'chunk-layout') {
        input.observedCookieHeader = proofHeader();
        input.proof = { ...source, rawCredential: 'a'.repeat(9000) };
      }
      if (failure === 'ttl') input.proofMaxAgeSeconds = 0;
      expect(() => {
        const candidate = buildBrowserProofCookieCandidate(input);
        mutate(candidate);
      }).toThrow();
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it('keeps errors free of the source credential/header contents', () => {
    expect(() =>
      buildBrowserProofCookieCandidate({
        cursor,
        proof: { ...source, rawCredential: 'secret\ncredential' },
        proofMaxAgeSeconds: 10,
        observedCookieHeader: null,
      }),
    ).toThrow('INVALID_SOURCE');
  });
  it.each(['single', 'chunked', 'retained'] as const)(
    'refuses an unreadable next-request pair count before publishing %s proof',
    (kind) => {
      const count = kind === 'chunked' ? 127 : kind === 'retained' ? 127 : 128;
      const unrelated = Array.from({ length: count }, (_unused, index) => `preference${index}=x`);
      if (kind === 'retained') unrelated.push(proofHeader(source, { ...cursor, version: 1 }));
      expect(() =>
        buildBrowserProofCookieCandidate({
          cursor,
          proof: kind === 'chunked' ? { ...source, rawCredential: 'a'.repeat(3_000) } : source,
          proofMaxAgeSeconds: 3_600,
          observedCookieHeader: unrelated.join('; '),
          retainObservedProofCookies: kind === 'retained',
        }),
      ).toThrow('COOKIE_BUDGET');
    },
  );
  it('keeps a readable exact-capacity replacement without counting the current family twice', () => {
    const unrelated = Array.from({ length: 127 }, (_unused, index) => `preference${index}=x`);
    const observed = [...unrelated, proofHeader()].join('; ');
    const candidate = buildBrowserProofCookieCandidate({
      cursor,
      proof: source,
      proofMaxAgeSeconds: 3_600,
      observedCookieHeader: observed,
    });
    const projected = [...unrelated, ...candidate.proofHeaders.map(pair)].join('; ');
    expect(projected.split(';')).toHaveLength(128);
    expect(readBrowserProofCookie(projected, cursor)).toEqual({ status: 'present', proof: source });
  });
  it('counts exact observed older-family clears when checking future readability', () => {
    const unrelated = Array.from({ length: 127 }, (_unused, index) => `preference${index}=x`);
    const older = proofHeader(source, { ...cursor, version: 1 });
    const candidate = buildBrowserProofCookieCandidate({
      cursor,
      proof: source,
      proofMaxAgeSeconds: 3_600,
      observedCookieHeader: [...unrelated, older].join('; '),
    });
    expect(candidate.garbageCollectionHeaders).toHaveLength(1);
    const projected = [...unrelated, ...candidate.proofHeaders.map(pair)].join('; ');
    expect(projected.split(';')).toHaveLength(128);
    expect(readBrowserProofCookie(projected, cursor)).toEqual({ status: 'present', proof: source });
  });
  it('validates the host-only canonical coordinator scope and uses a relative constant lease', () => {
    const token = randomBytes(32).toString('base64url');
    const bindingId = createHash('sha256').update(token).digest('hex');
    const input = {
      token,
      bindingId,
      servingOrigin: 'https://www.boardsesh.test',
      canonicalOrigin: 'https://www.boardsesh.test',
    };
    const header = buildCanonicalCoordinatorCorrelationCookie(input);
    expect(header).toBe(
      `${BROWSER_CORRELATION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${BROWSER_CORRELATION_LEASE_SECONDS}`,
    );
    expect(readBrowserCorrelationCookie(pair(header))).toEqual({ status: 'present', token, bindingId });
    expect(() =>
      buildCanonicalCoordinatorCorrelationCookie({ ...input, servingOrigin: 'https://app.boardsesh.test' }),
    ).toThrow();
    expect(() => buildCanonicalCoordinatorCorrelationCookie({ ...input, bindingId: 'b'.repeat(64) })).toThrow();
  });
  it.each(['duplicate', 'chunk', 'bad-token'] as const)('refuses ambiguous correlation input %s', (failure) => {
    const token = randomBytes(32).toString('base64url');
    const normal = `${BROWSER_CORRELATION_COOKIE}=${token}`;
    const header =
      failure === 'duplicate'
        ? `${normal}; ${normal}`
        : failure === 'chunk'
          ? `${normal}; ${BROWSER_CORRELATION_COOKIE}.0=${token}`
          : `${BROWSER_CORRELATION_COOKIE}=short`;
    expect(readBrowserCorrelationCookie(header)).toEqual({ status: 'invalid' });
  });
});
