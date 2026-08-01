import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { normalizeClientIp, resolveWebSocketClientIp, resolveWebSocketSocketPeerIp } from '../websocket/client-ip';

type UpgradeRequestParts = {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
};

function fakeUpgradeRequest({ headers = {}, remoteAddress }: UpgradeRequestParts): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('resolveWebSocketClientIp', () => {
  it('prefers cf-connecting-ip over the forwarded chain', () => {
    const resolved = resolveWebSocketClientIp(
      fakeUpgradeRequest({
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '198.51.100.9, 172.68.1.1',
        },
        remoteAddress: '10.0.0.1',
      }),
    );

    expect(resolved).toBe('203.0.113.7');
  });

  it('takes the LAST x-forwarded-for hop so a client-prefixed entry is ignored', () => {
    const resolved = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'x-forwarded-for': '198.51.100.9, 172.68.1.1' } }),
    );

    expect(resolved).toBe('172.68.1.1');
  });

  it('ignores x-real-ip entirely — nothing in our chain sets it', () => {
    const resolved = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'x-real-ip': '198.51.100.9' }, remoteAddress: '10.0.0.1' }),
    );

    expect(resolved).toBe('10.0.0.1');
  });

  it('falls back to the socket address when no proxy header is present', () => {
    const resolved = resolveWebSocketClientIp(fakeUpgradeRequest({ remoteAddress: '10.0.0.1' }));

    expect(resolved).toBe('10.0.0.1');
  });

  it('returns undefined when there is no request at all', () => {
    // undefined (not a sentinel string) so applyRateLimit can fall through to
    // its connectionId branch instead of pooling everyone under one key.
    expect(resolveWebSocketClientIp(undefined)).toBeUndefined();
  });

  it('returns undefined when every candidate is junk rather than keying on it', () => {
    const resolved = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': 'also, junk' } }),
    );

    expect(resolved).toBeUndefined();
  });

  it('falls through to the next candidate when a header holds a junk value', () => {
    const resolved = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'cf-connecting-ip': '<script>' }, remoteAddress: '10.0.0.1' }),
    );

    expect(resolved).toBe('10.0.0.1');
  });

  it('falls through to the socket when the last forwarded hop is junk', () => {
    // The leading hop is a well-formed IP but client-authored, so a junk last
    // hop must reach the socket rather than silently promoting the attacker's
    // entry back into the key.
    const resolved = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'x-forwarded-for': '198.51.100.9, <script>' }, remoteAddress: '10.0.0.1' }),
    );

    expect(resolved).toBe('10.0.0.1');
  });

  it('unwraps an IPv4-mapped IPv6 socket address so it shares the header path bucket', () => {
    const viaSocket = resolveWebSocketClientIp(fakeUpgradeRequest({ remoteAddress: '::ffff:203.0.113.5' }));
    const viaHeader = resolveWebSocketClientIp(fakeUpgradeRequest({ headers: { 'cf-connecting-ip': '203.0.113.5' } }));

    expect(viaSocket).toBe('203.0.113.5');
    expect(viaSocket).toBe(viaHeader);
  });

  it('truncates an IPv6 client to its /64 prefix so a routed /64 is one bucket', () => {
    const firstHost = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'cf-connecting-ip': '2001:0db8:85a3:0000:1111:2222:3333:4444' } }),
    );
    const secondHost = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'cf-connecting-ip': '2001:db8:85a3:0:aaaa:bbbb:cccc:dddd' } }),
    );

    expect(firstHost).toBe('2001:db8:85a3:0::/64');
    expect(secondHost).toBe(firstHost);
  });

  it('joins an array-valued header before taking the last hop', () => {
    // Defensive only: Node joins duplicate request headers into one string
    // (set-cookie is the sole array-valued header), so this shape is
    // type-level rather than something a real upgrade produces.
    const resolved = resolveWebSocketClientIp(
      fakeUpgradeRequest({ headers: { 'x-forwarded-for': ['198.51.100.9', '172.68.1.1'] } }),
    );

    expect(resolved).toBe('172.68.1.1');
  });
});

describe('normalizeClientIp', () => {
  it.each([
    ['  203.0.113.5  ', '203.0.113.5'],
    ['[2001:db8::1]', '2001:db8:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['2001:DB8:85A3::1', '2001:db8:85a3:0::/64'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeClientIp(raw)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    '   ',
    'unknown',
    'not-an-ip',
    '999.1.1.1',
    '192.0.2.1::',
    '2001:192.0.2.1::',
    '[2001:db8::1',
    '2001:db8::1]',
    '203.0.113.5%eth0',
  ])('rejects %j so the caller can try the next candidate', (raw) => {
    expect(normalizeClientIp(raw)).toBeUndefined();
  });

  it('keeps an embedded trailing IPv4 out of the /64 prefix', () => {
    expect(normalizeClientIp('2001:db8:85a3:1::192.0.2.1')).toBe('2001:db8:85a3:1::/64');
  });

  it('preserves a bracketed IPv6 socket address with a zone identifier', () => {
    expect(normalizeClientIp('[fe80::1%eth0]')).toBe('fe80:0:0:0::/64');
  });

  it('keys the hex form of an IPv4-mapped address as IPv6 instead of dropping it', () => {
    // `::ffff:c000:0201` is a valid IPv6 literal whose tail (`c000:0201`) is not
    // an IP, so the `::ffff:` unwrap must not fire here.
    //
    // Accepted consequence: every hex-form IPv4-mapped literal starts with the
    // same four zero hextets, so they all collapse into the single
    // `0:0:0:0::/64` bucket. Node renders IPv4-mapped socket addresses in dotted
    // form and Cloudflare sends dotted `cf-connecting-ip`, so this shape only
    // reaches us from a hand-forged header — sharing one bucket is the safe
    // direction (stricter, not looser) for that traffic.
    expect(normalizeClientIp('::ffff:c000:0201')).toBe('0:0:0:0::/64');
  });
});

describe('resolveWebSocketSocketPeerIp', () => {
  it('ignores forgeable proxy headers and returns only the normalized TCP peer', () => {
    const request = fakeUpgradeRequest({
      headers: {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '198.51.100.9, 172.68.1.1',
      },
      remoteAddress: '::ffff:10.0.0.8',
    });

    expect(resolveWebSocketSocketPeerIp(request)).toBe('10.0.0.8');
  });

  it('returns undefined when no socket peer can be normalized', () => {
    expect(resolveWebSocketSocketPeerIp(undefined)).toBeUndefined();
    expect(resolveWebSocketSocketPeerIp(fakeUpgradeRequest({ remoteAddress: 'not-an-ip' }))).toBeUndefined();
  });
});
