import { describe, expect, it } from 'vite-plus/test';
import { isIpInAnyCidr, isIpInCidr, normalizeRateLimitIp } from '../ip';

describe('normalizeRateLimitIp', () => {
  it.each([
    [' 203.0.113.5 ', '203.0.113.5'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['::ffff:cb00:7105', '203.0.113.5'],
    ['0:0:0:0:0:ffff:cb00:7105', '203.0.113.5'],
    ['0:0:0:0:0:ffff:203.0.113.5', '203.0.113.5'],
    ['::ffff:c633:6409', '198.51.100.9'],
    ['2001:0db8:85a3:0000:1111:2222:3333:4444', '2001:db8:85a3:0::/64'],
    ['2001:db8:85a3:0:aaaa:bbbb:cccc:dddd', '2001:db8:85a3:0::/64'],
    ['[fe80::1%eth0]', 'fe80:0:0:0::/64'],
  ])('normalizes %j to %j', (rawAddress, expectedIdentity) => {
    expect(normalizeRateLimitIp(rawAddress)).toBe(expectedIdentity);
  });

  it.each([
    undefined,
    '',
    'unknown',
    '999.1.1.1',
    '203.0.113.1, 198.51.100.1',
    '192.0.2.1::',
    '2001:192.0.2.1::',
    '[2001:db8::1',
    '2001:db8::1]',
    '[[2001:db8::1]]',
    '203.0.113.5%eth0',
    'fe80::1%',
    'fe80::1%eth0%forged',
  ])('rejects %j', (rawAddress) => {
    expect(normalizeRateLimitIp(rawAddress)).toBeUndefined();
  });
});

describe('isIpInCidr', () => {
  it.each([
    ['173.245.48.1', '173.245.48.0/20', true],
    ['173.245.63.255', '173.245.48.0/20', true],
    ['173.245.64.1', '173.245.48.0/20', false],
    ['::ffff:173.245.48.1', '173.245.48.0/20', true],
    ['::ffff:adf5:3001', '173.245.48.0/20', true],
    ['0:0:0:0:0:ffff:adf5:3001', '173.245.48.0/20', true],
    ['0:0:0:0:0:ffff:173.245.48.1', '173.245.48.0/20', true],
    ['2a06:98c7:ffff::1', '2a06:98c0::/29', true],
    ['2a06:98c8::1', '2a06:98c0::/29', false],
  ])('matches %j against %j as %j', (rawAddress, cidr, expected) => {
    expect(isIpInCidr(rawAddress, cidr)).toBe(expected);
  });

  it.each([
    [undefined, '173.245.48.0/20'],
    ['173.245.48.1, 198.51.100.1', '173.245.48.0/20'],
    ['173.245.48.1:443', '173.245.48.0/20'],
    ['[173.245.48.1]', '173.245.48.0/20'],
    ['fe80::1%eth0', 'fe80::/10'],
  ])('rejects malformed address %j against %j', (rawAddress, cidr) => {
    expect(isIpInCidr(rawAddress, cidr)).toBe(false);
  });

  it('rejects malformed CIDRs and checks lists without relaxing parsing', () => {
    expect(isIpInCidr('173.245.48.1', '173.245.48.0/33')).toBe(false);
    expect(isIpInCidr('173.245.48.1', '173.245.48.0/20/extra')).toBe(false);
    expect(isIpInAnyCidr('173.245.48.1', ['192.0.2.0/24', '173.245.48.0/20'])).toBe(true);
    expect(isIpInAnyCidr('203.0.113.8', ['192.0.2.0/24', '173.245.48.0/20'])).toBe(false);
  });
});
