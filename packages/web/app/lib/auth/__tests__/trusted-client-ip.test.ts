import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
import { stagedPasswordClientKey, trustedClientRateLimitKey } from '../trusted-client-ip.server';

const CLOUDFLARE_EDGE = '172.70.1.2';
const OTHER_CLOUDFLARE_EDGE = '162.158.4.5';
const VISITOR = '203.0.113.9';
const FORGED = '198.51.100.7';

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
