import { describe, it, expect } from 'vitest';
import { isCloudflareEdgeAddress, normalizeIpAddress, trustedEdgeCountry } from '../edge-country';

const CLOUDFLARE_V4 = '172.70.1.2';
const CLOUDFLARE_V6 = '2606:4700:10::ac43:1';
const VISITOR = '203.0.113.9';

describe('isCloudflareEdgeAddress', () => {
  it.each([CLOUDFLARE_V4, CLOUDFLARE_V6, `::ffff:${CLOUDFLARE_V4}`, ` ${CLOUDFLARE_V4} `])('accepts %s', (address) => {
    expect(isCloudflareEdgeAddress(address)).toBe(true);
  });

  it.each([VISITOR, '10.0.0.4', 'not-an-ip', '', undefined])('refuses %s', (address) => {
    expect(isCloudflareEdgeAddress(address)).toBe(false);
  });
});

describe('normalizeIpAddress', () => {
  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(normalizeIpAddress('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('trustedEdgeCountry', () => {
  it('reads the country when the last hop is Cloudflare', () => {
    expect(trustedEdgeCountry({ forwardedFor: `${VISITOR}, ${CLOUDFLARE_V4}`, country: 'US' })).toBe('US');
  });

  // Straight to the origin: our ingress appends the caller's own address, so a
  // Cloudflare address the caller wrote earlier in the header buys nothing.
  it('refuses a country when the last hop is not Cloudflare', () => {
    expect(trustedEdgeCountry({ forwardedFor: `${CLOUDFLARE_V4}, ${VISITOR}`, country: 'US' })).toBeNull();
  });

  it('refuses a country with no forwarded header at all', () => {
    expect(trustedEdgeCountry({ forwardedFor: null, country: 'US' })).toBeNull();
  });

  it.each(['XX', 'T1', 'us', '', undefined])('refuses the unknown code %s', (country) => {
    expect(trustedEdgeCountry({ forwardedFor: CLOUDFLARE_V4, country })).toBeNull();
  });
});
