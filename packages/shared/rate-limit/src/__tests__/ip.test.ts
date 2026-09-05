import { describe, expect, it } from 'vite-plus/test';
import { normalizeRateLimitIp } from '../ip';

describe('normalizeRateLimitIp', () => {
  it.each([
    [' 203.0.113.5 ', '203.0.113.5'],
    ['::ffff:203.0.113.5', '203.0.113.5'],
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
