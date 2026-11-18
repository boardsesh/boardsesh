import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
import {
  CLOUDFLARE_ORIGIN_PROOF_HEADER,
  CLOUDFLARE_ORIGIN_PROOF_NEXT_SECRET_ENV,
  CLOUDFLARE_ORIGIN_PROOF_SECRET_ENV,
  cloudflareVisitorRateLimitKey,
  cloudflareVouchedVisitorAddress,
  stagedPasswordClientKey,
  trustedClientRateLimitKey,
} from '../trusted-client-ip.server';

const CLOUDFLARE_EDGE = '172.70.1.2';
const OTHER_CLOUDFLARE_EDGE = '162.158.4.5';
const VISITOR = '203.0.113.9';
const FORGED = '198.51.100.7';
const PROOF_SECRET = 'origin-proof-fixture-secret-at-least-32-bytes';
const proof = (value = PROOF_SECRET) => ({ [CLOUDFLARE_ORIGIN_PROOF_HEADER]: value });
const configureProof = (value = PROOF_SECRET) => vi.stubEnv(CLOUDFLARE_ORIGIN_PROOF_SECRET_ENV, value);

function requestWith(headers: Record<string, string>) {
  return new Request('https://www.boardsesh.test/api/auth/forgot-password', { method: 'POST', headers });
}

describe('trustedClientRateLimitKey', () => {
  it('uses the Cloudflare visitor when the last hop is Cloudflare, ignoring earlier entries', () => {
    const key = trustedClientRateLimitKey(
      requestWith({
        'X-Forwarded-For': `${FORGED}, ${VISITOR}, ${CLOUDFLARE_EDGE}`,
        'CF-Connecting-IP': VISITOR,
      }),
    );
    expect(key).toBe(VISITOR);
  });

  it('uses the last hop for a direct-origin caller, ignoring a forged Cloudflare header', () => {
    const key = trustedClientRateLimitKey(
      requestWith({
        'X-Forwarded-For': `${CLOUDFLARE_EDGE}, ${VISITOR}`,
        'CF-Connecting-IP': FORGED,
      }),
    );
    expect(key).toBe(VISITOR);
  });

  it('cannot be moved by rotating the caller-written first hop', () => {
    const keys = ['192.0.2.1', '192.0.2.2', '192.0.2.3'].map((rotated) =>
      trustedClientRateLimitKey(
        requestWith({ 'X-Forwarded-For': `${rotated}, ${CLOUDFLARE_EDGE}`, 'CF-Connecting-IP': VISITOR }),
      ),
    );
    expect(new Set(keys)).toEqual(new Set([VISITOR]));
  });

  it('puts edge requests with no usable visitor in one bucket, whichever edge carried them', () => {
    const missingVisitor = trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE }));
    const unusableVisitor = trustedClientRateLimitKey(
      requestWith({ 'X-Forwarded-For': OTHER_CLOUDFLARE_EDGE, 'CF-Connecting-IP': 'not-an-ip' }),
    );
    expect(missingVisitor).toBe('edge-without-visitor');
    expect(unusableVisitor).toBe('edge-without-visitor');
  });

  it('groups a rotating IPv6 client by its /64 and separates other networks', () => {
    const keyFor = (visitor: string) =>
      trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': visitor }));
    expect(keyFor('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(keyFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(keyFor('2001:0DB8:0001:0002::ffff')).toBe('2001:db8:1:2::/64');
    expect(keyFor('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(keyFor('::1:2')).toBe('0:0:0:0::/64');
  });

  // 203.0.113.9 is cb00:7109 in hex.
  it.each([
    `::ffff:${VISITOR}`,
    '::ffff:cb00:7109',
    '::FFFF:CB00:7109',
    '0:0:0:0:0:ffff:cb00:7109',
    '0000:0000:0000:0000:0000:ffff:cb00:7109',
    `0:0:0:0:0:ffff:${VISITOR}`,
  ])('reads the IPv4-mapped visitor %s as the dotted address', (mapped) => {
    expect(
      trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': mapped })),
    ).toBe(VISITOR);
  });

  it('reads an IPv4-mapped direct-origin last hop as the dotted address', () => {
    expect(trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': `${FORGED}, ::ffff:cb00:7109` }))).toBe(VISITOR);
  });

  const unreadableForwardedFor: Record<string, string>[] = [
    {},
    { 'X-Forwarded-For': 'not-an-ip' },
    { 'X-Forwarded-For': `${VISITOR}, ` },
  ];
  it.each(unreadableForwardedFor)('shares one bucket when no last hop can be read: %j', (headers) => {
    expect(trustedClientRateLimitKey(requestWith(headers))).toBe('unknown');
  });
});

describe('cloudflareVouchedVisitorAddress', () => {
  afterEach(() => vi.unstubAllEnvs());
  const edgeVisitor = (extra: Record<string, string> = {}) =>
    requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': VISITOR, ...extra });

  it('returns the visitor when our zone proved the request, ignoring caller-written earlier hops', () => {
    configureProof();
    const address = cloudflareVouchedVisitorAddress(
      requestWith({
        'X-Forwarded-For': `${FORGED}, ${OTHER_CLOUDFLARE_EDGE}, ${CLOUDFLARE_EDGE}`,
        'CF-Connecting-IP': VISITOR,
        ...proof(),
      }),
    );
    expect(address).toBe(VISITOR);
  });

  // A Worker on any account that fetches our Railway domain leaves from a
  // Cloudflare address and may set CF-Connecting-IP itself.
  it('never trusts a Cloudflare last hop and a forged visitor without the proof header', () => {
    configureProof();
    expect(cloudflareVouchedVisitorAddress(edgeVisitor())).toBeNull();
  });

  it('never trusts a wrong proof', () => {
    configureProof();
    expect(
      cloudflareVouchedVisitorAddress(edgeVisitor(proof('not-the-origin-proof-secret-but-as-long-as-it'))),
    ).toBeNull();
    expect(cloudflareVouchedVisitorAddress(edgeVisitor(proof(`${PROOF_SECRET}x`)))).toBeNull();
    expect(cloudflareVouchedVisitorAddress(edgeVisitor(proof('')))).toBeNull();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['shorter than 32 bytes', 'short-origin-proof-secret'],
  ])('never trusts anything while the proof secret is %s', (_case, secret) => {
    if (secret !== undefined) configureProof(secret);
    const presented = secret ? proof(secret) : proof();
    expect(cloudflareVouchedVisitorAddress(edgeVisitor(presented))).toBeNull();
  });

  it('never trusts a direct-origin caller, whatever Cloudflare header, earlier edge hop or proof it sends', () => {
    configureProof();
    const address = cloudflareVouchedVisitorAddress(
      requestWith({ 'X-Forwarded-For': `${CLOUDFLARE_EDGE}, ${VISITOR}`, 'CF-Connecting-IP': FORGED, ...proof() }),
    );
    expect(address).toBeNull();
  });

  it('keeps the whole IPv6 address, so the backend can group it by /64 itself', () => {
    configureProof();
    const address = cloudflareVouchedVisitorAddress(
      requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': '2001:0DB8:1:2:AAAA::1', ...proof() }),
    );
    expect(address).toBe('2001:0db8:1:2:aaaa::1');
  });

  it('reads an IPv4-mapped visitor as the dotted address', () => {
    configureProof();
    expect(cloudflareVouchedVisitorAddress(edgeVisitor({ 'CF-Connecting-IP': `::ffff:${VISITOR}`, ...proof() }))).toBe(
      VISITOR,
    );
  });

  const noVouchedVisitor: Record<string, string>[] = [
    {},
    { 'CF-Connecting-IP': VISITOR },
    { 'X-Forwarded-For': CLOUDFLARE_EDGE },
    { 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': 'not-an-ip' },
    { 'X-Forwarded-For': `${CLOUDFLARE_EDGE}, `, 'CF-Connecting-IP': VISITOR },
    { 'X-Forwarded-For': 'fd12:3456::1', 'CF-Connecting-IP': VISITOR },
  ];
  it.each(noVouchedVisitor)('returns null without a Cloudflare-vouched visitor, even with the proof: %j', (headers) => {
    configureProof();
    expect(cloudflareVouchedVisitorAddress(requestWith({ ...headers, ...proof() }))).toBeNull();
  });
});

describe('with the origin proof secret unset or unusable, every helper behaves exactly as on main', () => {
  afterEach(() => vi.unstubAllEnvs());
  const edgeVisitor = (visitor: string) => ({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': visitor });

  // What main returns for each input, with or without a proof header on the request.
  const mainBehaviour: [string, Record<string, string>, string, string | null][] = [
    ['a Cloudflare hop and a visitor', edgeVisitor(VISITOR), VISITOR, VISITOR],
    ['a Cloudflare hop and a forged visitor', edgeVisitor(FORGED), FORGED, FORGED],
    ['a Cloudflare hop without a visitor', { 'X-Forwarded-For': CLOUDFLARE_EDGE }, 'edge-without-visitor', null],
    [
      'an ordinary last hop',
      { 'X-Forwarded-For': `${CLOUDFLARE_EDGE}, ${VISITOR}`, 'CF-Connecting-IP': FORGED },
      VISITOR,
      null,
    ],
    ['no hop', {}, 'unknown', null],
  ];
  const unusableSecrets: [string, string | undefined][] = [
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', ' '.repeat(40)],
    ['31 bytes', 'a'.repeat(31)],
  ];

  describe.each(unusableSecrets)('secret %s', (_case, secret) => {
    describe.each(mainBehaviour)('%s', (_input, headers, trustedKey, visitorKey) => {
      it.each([
        ['without a proof header', {}],
        ['with a proof header', proof(secret?.trim() || PROOF_SECRET)],
      ])('%s', (_proofCase, proofHeaders) => {
        if (secret !== undefined) configureProof(secret);
        const request = () => requestWith({ ...headers, ...proofHeaders });
        expect(trustedClientRateLimitKey(request())).toBe(trustedKey);
        expect(cloudflareVisitorRateLimitKey(request())).toBe(visitorKey);
        expect(cloudflareVouchedVisitorAddress(request())).toBeNull();
        vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
        expect(stagedPasswordClientKey(request())).toBe(trustedKey);
      });
    });
  });

  it('counts a 32-byte secret as set', () => {
    configureProof('a'.repeat(32));
    expect(cloudflareVouchedVisitorAddress(requestWith({ ...edgeVisitor(VISITOR), ...proof('a'.repeat(32)) }))).toBe(
      VISITOR,
    );
    expect(trustedClientRateLimitKey(requestWith(edgeVisitor(FORGED)))).toBe(CLOUDFLARE_EDGE);
  });
});

describe('with the origin proof secret set (#7766)', () => {
  // Unproven requests log a warning; keep it out of the test output.
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const forgedViaWorker = (extra: Record<string, string> = {}) =>
    requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': FORGED, ...extra });

  it('keys a Cloudflare last hop without the proof on that hop, never on the forged visitor', () => {
    configureProof();
    expect(trustedClientRateLimitKey(forgedViaWorker())).toBe(CLOUDFLARE_EDGE);
    expect(trustedClientRateLimitKey(forgedViaWorker(proof('not-the-origin-proof-secret-but-as-long-as-it')))).toBe(
      CLOUDFLARE_EDGE,
    );
  });

  // The legacy sign-in limit skips a null key, so an unproven request must never get one.
  it('never lets the legacy key skip an unproven request', () => {
    configureProof();
    expect(cloudflareVisitorRateLimitKey(forgedViaWorker())).toBe(CLOUDFLARE_EDGE);
    expect(cloudflareVisitorRateLimitKey(requestWith({ 'X-Forwarded-For': '2606:4700:10::6816:1' }))).toBe(
      '2606:4700:10:0::/64',
    );
    expect(
      cloudflareVisitorRateLimitKey(
        requestWith({ 'X-Forwarded-For': `${CLOUDFLARE_EDGE}, ${VISITOR}`, 'CF-Connecting-IP': FORGED }),
      ),
    ).toBe(VISITOR);
    expect(cloudflareVisitorRateLimitKey(requestWith({ 'CF-Connecting-IP': FORGED }))).toBe('unknown');
  });

  it('keys on the visitor when the proof is right', () => {
    configureProof();
    expect(trustedClientRateLimitKey(forgedViaWorker(proof()))).toBe(FORGED);
    expect(cloudflareVisitorRateLimitKey(forgedViaWorker(proof()))).toBe(FORGED);
  });

  it('keeps main for a proven request with no usable visitor or no Cloudflare hop', () => {
    configureProof();
    expect(cloudflareVisitorRateLimitKey(requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, ...proof() }))).toBeNull();
    expect(cloudflareVisitorRateLimitKey(requestWith({ 'X-Forwarded-For': VISITOR, ...proof() }))).toBeNull();
  });

  it('leaves a direct-origin caller keyed on its own last hop', () => {
    configureProof();
    expect(trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': VISITOR, 'CF-Connecting-IP': FORGED }))).toBe(
      VISITOR,
    );
  });

  describe('rotation through the NEXT secret', () => {
    const NEXT_SECRET = 'next-origin-proof-fixture-secret-at-least-32-bytes';
    const configureNext = (value = NEXT_SECRET) => vi.stubEnv(CLOUDFLARE_ORIGIN_PROOF_NEXT_SECRET_ENV, value);

    it('accepts either value while both are set', () => {
      configureProof();
      configureNext();
      expect(cloudflareVouchedVisitorAddress(forgedViaWorker(proof()))).toBe(FORGED);
      expect(cloudflareVouchedVisitorAddress(forgedViaWorker(proof(NEXT_SECRET)))).toBe(FORGED);
      expect(
        cloudflareVouchedVisitorAddress(forgedViaWorker(proof('neither-of-the-two-origin-proof-secrets'))),
      ).toBeNull();
    });

    it('ignores a NEXT value under 32 bytes', () => {
      configureProof();
      configureNext('a'.repeat(31));
      expect(cloudflareVouchedVisitorAddress(forgedViaWorker(proof('a'.repeat(31))))).toBeNull();
      expect(cloudflareVouchedVisitorAddress(forgedViaWorker(proof()))).toBe(FORGED);
    });

    it('works with NEXT alone, for the moment between moving it and unsetting it', () => {
      configureNext();
      expect(cloudflareVouchedVisitorAddress(forgedViaWorker(proof(NEXT_SECRET)))).toBe(FORGED);
      expect(trustedClientRateLimitKey(forgedViaWorker())).toBe(CLOUDFLARE_EDGE);
    });
  });

  describe('the warning that tells an owner the rule is missing', () => {
    // Well past any real clock reading, then a fresh window per test, so the
    // once-a-minute gate never carries over from another test.
    let clock = Date.now() + 24 * 60 * 60_000;
    const warnings = () => {
      clock += 10 * 60_000;
      vi.useFakeTimers({ now: clock });
      return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    };
    afterEach(() => vi.useRealTimers());
    const eventsIn = (warn: ReturnType<typeof warnings>) =>
      warn.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; unprovenSinceLastWarning: number });

    it('logs a Cloudflare last hop without the proof, at most once a minute', () => {
      configureProof();
      const warn = warnings();
      for (let call = 0; call < 5; call += 1) trustedClientRateLimitKey(forgedViaWorker());
      // Earlier tests' unproven calls may be in the first count; the second count is exact.
      expect(eventsIn(warn)).toEqual([
        {
          event: 'cloudflare_origin_proof_missing',
          path: '/api/auth/forgot-password',
          unprovenSinceLastWarning: expect.any(Number),
        },
      ]);
      vi.advanceTimersByTime(60_000);
      cloudflareVisitorRateLimitKey(forgedViaWorker());
      expect(eventsIn(warn)).toHaveLength(2);
      expect(eventsIn(warn)[1].unprovenSinceLastWarning).toBe(5);
    });

    it.each([
      ['a proven request', () => forgedViaWorker(proof())],
      ['an ordinary last hop', () => requestWith({ 'X-Forwarded-For': VISITOR })],
      ['no hop', () => requestWith({})],
    ])('stays quiet for %s', (_case, request) => {
      configureProof();
      const warn = warnings();
      trustedClientRateLimitKey(request());
      cloudflareVisitorRateLimitKey(request());
      cloudflareVouchedVisitorAddress(request());
      expect(warn).not.toHaveBeenCalled();
    });

    it('stays quiet while the secret is unset', () => {
      const warn = warnings();
      trustedClientRateLimitKey(forgedViaWorker());
      cloudflareVisitorRateLimitKey(forgedViaWorker());
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('stagedPasswordClientKey', () => {
  afterEach(() => vi.unstubAllEnvs());
  const edgeRequest = () => requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': VISITOR });

  it('returns the trusted key in staged mode', () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    expect(stagedPasswordClientKey(edgeRequest())).toBe(VISITOR);
  });

  it.each(['', 'legacy', 'misconfigured'])('returns null for mode %j', (mode) => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', mode);
    expect(stagedPasswordClientKey(edgeRequest())).toBeNull();
  });

  it('returns null when the mode is unset', () => {
    expect(stagedPasswordClientKey(edgeRequest())).toBeNull();
  });
});
