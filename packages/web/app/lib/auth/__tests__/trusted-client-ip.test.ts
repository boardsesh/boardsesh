import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
import {
  CLOUDFLARE_ORIGIN_PROOF_HEADER,
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

describe('the origin proof on the existing limiter keys (#7766)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const forgedViaWorker = (extra: Record<string, string> = {}) =>
    requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE, 'CF-Connecting-IP': FORGED, ...extra });

  // Pins main's behaviour until an owner sets the secret: nothing live changes in this PR.
  it.each([
    ['unset', undefined],
    ['shorter than 32 bytes', 'short-origin-proof-secret'],
  ])('behave exactly as before while the proof secret is %s', (_case, secret) => {
    if (secret !== undefined) configureProof(secret);
    expect(trustedClientRateLimitKey(forgedViaWorker())).toBe(FORGED);
    expect(cloudflareVisitorRateLimitKey(forgedViaWorker())).toBe(FORGED);
    expect(trustedClientRateLimitKey(forgedViaWorker(proof('anything-at-all')))).toBe(FORGED);
    expect(trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': CLOUDFLARE_EDGE }))).toBe('edge-without-visitor');
    expect(trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': `${CLOUDFLARE_EDGE}, ${VISITOR}` }))).toBe(
      VISITOR,
    );
    expect(trustedClientRateLimitKey(requestWith({}))).toBe('unknown');
  });

  it('key a Cloudflare last hop without the proof on that hop, never on the forged visitor', () => {
    configureProof();
    expect(trustedClientRateLimitKey(forgedViaWorker())).toBe(CLOUDFLARE_EDGE);
    expect(trustedClientRateLimitKey(forgedViaWorker(proof('not-the-origin-proof-secret-but-as-long-as-it')))).toBe(
      CLOUDFLARE_EDGE,
    );
    expect(cloudflareVisitorRateLimitKey(forgedViaWorker())).toBeNull();
  });

  it('key on the visitor when the proof is right', () => {
    configureProof();
    expect(trustedClientRateLimitKey(forgedViaWorker(proof()))).toBe(FORGED);
    expect(cloudflareVisitorRateLimitKey(forgedViaWorker(proof()))).toBe(FORGED);
  });

  it('leave a direct-origin caller keyed on its own last hop', () => {
    configureProof();
    expect(trustedClientRateLimitKey(requestWith({ 'X-Forwarded-For': VISITOR, 'CF-Connecting-IP': FORGED }))).toBe(
      VISITOR,
    );
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
