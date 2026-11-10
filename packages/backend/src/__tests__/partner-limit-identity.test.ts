import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vite-plus/test';
import { CLOUDFLARE_WORKER_EGRESS_ADDRESS, getPartnerLimitIdentity, getTrustedClientIp } from '../utils/client-ip';

/**
 * The identity the partner OAuth limits count. Only Cloudflare's Worker egress
 * address, reported by a verified Cloudflare edge, is keyed by its `CF-Worker`
 * zone; everything else is exactly `getTrustedClientIp`.
 */

const PRIVATE_INGRESS = '10.0.0.5';
const CLOUDFLARE_EDGE = '173.245.48.5';
const WORKER_ADDRESS_KEY = '2a06:98c0:3600:0::/64';

function requestFrom(socketPeer: string, headers: Record<string, string | string[]>): IncomingMessage {
  return { socket: { remoteAddress: socketPeer }, headers } as unknown as IncomingMessage;
}

/** Through our private ingress, from a Cloudflare edge that reported this visitor. */
function viaCloudflare(visitor: string, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return requestFrom(PRIVATE_INGRESS, {
    'x-forwarded-for': `198.51.100.1, ${CLOUDFLARE_EDGE}`,
    'cf-connecting-ip': visitor,
    ...headers,
  });
}

describe('getPartnerLimitIdentity', () => {
  it("keys a Worker by its zone, and names the egress address's own identity for the ceiling", () => {
    expect(
      getPartnerLimitIdentity(viaCloudflare(CLOUDFLARE_WORKER_EGRESS_ADDRESS, { 'cf-worker': 'partner.example' })),
    ).toEqual({ key: 'cf-worker:partner.example', sharedEgress: WORKER_ADDRESS_KEY });
  });

  it('trusts a Cloudflare socket peer the same way', () => {
    const request = requestFrom(CLOUDFLARE_EDGE, {
      'cf-connecting-ip': CLOUDFLARE_WORKER_EGRESS_ADDRESS,
      'cf-worker': 'partner.example',
    });
    expect(getPartnerLimitIdentity(request)).toEqual({
      key: 'cf-worker:partner.example',
      sharedEgress: WORKER_ADDRESS_KEY,
    });
  });

  it.each([
    ['fully written', '2a06:98c0:3600:0:0:0:0:103'],
    ['zero-padded', '2a06:98c0:3600:0000:0000:0000:0000:0103'],
    ['upper case', '2A06:98C0:3600::103'],
  ])('recognises the Worker address written %s', (_label, address) => {
    expect(getPartnerLimitIdentity(viaCloudflare(address, { 'cf-worker': 'partner.example' })).key).toBe(
      'cf-worker:partner.example',
    );
  });

  it('lower-cases the zone and trims the header', () => {
    expect(
      getPartnerLimitIdentity(viaCloudflare(CLOUDFLARE_WORKER_EGRESS_ADDRESS, { 'cf-worker': ' Partner.EXAMPLE ' }))
        .key,
    ).toBe('cf-worker:partner.example');
  });

  it('accepts a 253-character zone of 63-character labels', () => {
    const zone = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(zone).toHaveLength(253);
    expect(getPartnerLimitIdentity(viaCloudflare(CLOUDFLARE_WORKER_EGRESS_ADDRESS, { 'cf-worker': zone })).key).toBe(
      `cf-worker:${zone}`,
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a single label', 'localhost'],
    ['two headers joined', 'one.example, two.example'],
    ['an array', ['one.example', 'two.example']],
    ['a port', 'partner.example:443'],
    ['a space', 'partner example.com'],
    ['a trailing dot', 'partner.example.'],
    ['an empty label', 'partner..example'],
    ['a leading hyphen', '-partner.example'],
    ['a trailing hyphen', 'partner-.example'],
    ['a 64-character label', `${'a'.repeat(64)}.example`],
    ['254 characters', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`],
    ['a non-ASCII letter', 'exämple.com'],
    ['an underscore', 'my_app.example'],
    ['a colon, which could forge another key', 'partner.example:203.0.113.9'],
  ])('keeps the Worker address on its own bucket when the zone is %s', (_label, header) => {
    const headers: Record<string, string | string[]> = header === undefined ? {} : { 'cf-worker': header };
    expect(getPartnerLimitIdentity(viaCloudflare(CLOUDFLARE_WORKER_EGRESS_ADDRESS, headers))).toEqual({
      key: WORKER_ADDRESS_KEY,
    });
  });

  it('ignores CF-Worker from another Cloudflare visitor, even one in the Worker /64', () => {
    expect(getPartnerLimitIdentity(viaCloudflare('203.0.113.9', { 'cf-worker': 'partner.example' }))).toEqual({
      key: '203.0.113.9',
    });
    expect(getPartnerLimitIdentity(viaCloudflare('2a06:98c0:3600::104', { 'cf-worker': 'partner.example' }))).toEqual({
      key: WORKER_ADDRESS_KEY,
    });
  });

  it('ignores both Cloudflare headers from a request that did not come through Cloudflare', () => {
    const forged = { 'cf-connecting-ip': CLOUDFLARE_WORKER_EGRESS_ADDRESS, 'cf-worker': 'partner.example' };
    // Through our ingress, from an ordinary address.
    expect(
      getPartnerLimitIdentity(requestFrom(PRIVATE_INGRESS, { 'x-forwarded-for': '198.51.100.7', ...forged })),
    ).toEqual({ key: '198.51.100.7' });
    // A caller-written Cloudflare hop earlier in the chain proves nothing.
    expect(
      getPartnerLimitIdentity(
        requestFrom(PRIVATE_INGRESS, { 'x-forwarded-for': `${CLOUDFLARE_EDGE}, 198.51.100.7`, ...forged }),
      ),
    ).toEqual({ key: '198.51.100.7' });
    // Straight to the origin from a public address.
    expect(getPartnerLimitIdentity(requestFrom('198.51.100.8', forged))).toEqual({ key: '198.51.100.8' });
  });

  it.each([
    ['a Cloudflare visitor', viaCloudflare('203.0.113.9')],
    ['a Cloudflare IPv6 visitor', viaCloudflare('2001:db8:9:9::1')],
    ['the Worker address with no zone', viaCloudflare(CLOUDFLARE_WORKER_EGRESS_ADDRESS)],
    ['the last forwarded hop', requestFrom(PRIVATE_INGRESS, { 'x-forwarded-for': '1.1.1.1, 198.51.100.7' })],
    ['an IPv6 forwarded hop', requestFrom(PRIVATE_INGRESS, { 'x-forwarded-for': '2001:db8:1:2::5' })],
    ['an IPv4-mapped hop', requestFrom(PRIVATE_INGRESS, { 'x-forwarded-for': '::ffff:203.0.113.9' })],
    ['a public socket peer', requestFrom('198.51.100.7', { 'x-forwarded-for': '1.1.1.1' })],
    ['an IPv6 socket peer', requestFrom('2001:db8:7:7::1', {})],
    [
      'a forged cf-connecting-ip',
      requestFrom(PRIVATE_INGRESS, { 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '203.0.113.9' }),
    ],
    ['no address at all', requestFrom('', {})],
  ])('is exactly getTrustedClientIp for %s', (_label, request) => {
    expect(getPartnerLimitIdentity(request)).toEqual({ key: getTrustedClientIp(request) });
  });
});
