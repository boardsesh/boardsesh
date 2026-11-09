import { describe, expect, it } from 'vitest';
import { isLocalControllerHost, normalizeControllerUrl, normalizeLocalControllerUrl } from '../url';

describe('controller base URLs', () => {
  it.each([
    ['  192.168.1.42  ', 'http://192.168.1.42'],
    ['wled.local:8080/', 'http://wled.local:8080'],
    ['https://wall.example/lighting/controller/', 'https://wall.example/lighting/controller'],
    ['http://[fd00::42]:8080', 'http://[fd00::42]:8080'],
  ])('normalizes %s without dropping a proxy path', (input, expected) => {
    expect(normalizeControllerUrl(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'https:/wled.local',
    'ftp://wled.local',
    'javascript:alert(1)',
    'http://user:secret@wled.local',
    'http://wled.local?token=secret',
    'http://wled.local#fragment',
    'http://wled.local?',
    'http://wled.local/a b',
    'http://wled.local/a\nb',
    'http:\\wled.local',
    'http://wled.local/%00',
    'http://wled.local:99999',
  ])('rejects unsafe or invalid input %s', (input) => {
    expect(() => normalizeControllerUrl(input)).toThrow(expect.objectContaining({ code: 'invalid-url' }));
  });
});

describe('local controller addresses', () => {
  it.each([
    ['192.168.1.42', 'http://192.168.1.42'],
    ['10.0.0.8:8080', 'http://10.0.0.8:8080'],
    ['http://172.16.0.1', 'http://172.16.0.1'],
    ['http://172.31.255.254', 'http://172.31.255.254'],
    ['http://169.254.10.20', 'http://169.254.10.20'],
    ['http://[fd00::42]:8080', 'http://[fd00::42]:8080'],
    ['http://[fe80::1]', 'http://[fe80::1]'],
    ['wled.local', 'http://wled.local'],
    ['https://wall.lan/proxy/', 'https://wall.lan/proxy'],
    ['wall.home', 'http://wall.home'],
    ['wall.home.arpa', 'http://wall.home.arpa'],
    ['wall.garage.internal', 'http://wall.garage.internal'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeLocalControllerUrl(input)).toBe(expected);
  });

  it.each([
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://172.15.0.1',
    'http://192.169.1.1',
    'http://100.64.0.1',
    'http://127.0.0.1',
    'http://0.0.0.0',
    'http://[::1]',
    'http://[2001:db8::1]',
    'http://[::ffff:192.168.1.1]',
    'http://localhost',
    'http://wled',
    'http://ai',
    'http://example.com',
    'http://wled.example.com',
    'http://wled.local.example.com',
  ])('refuses the public or loopback address %s', (input) => {
    expect(() => normalizeLocalControllerUrl(input)).toThrow(expect.objectContaining({ code: 'not-local' }));
  });

  it('still answers invalid-url for everything the base check refuses', () => {
    for (const input of [
      'http://user:pw@wled.local',
      'http://wled.local?a=1',
      'http://wled.local#x',
      'ftp://wled.local',
    ]) {
      expect(() => normalizeLocalControllerUrl(input)).toThrow(expect.objectContaining({ code: 'invalid-url' }));
    }
  });

  it.each(['2130706433', '0x7f000001', 'foo..local', 'wled.local.', '-bad.local', 'wled_wall.local', '[fe80::zz]'])(
    'refuses the odd host %s even when a parser let it through',
    (host) => {
      expect(isLocalControllerHost(host)).toBe(false);
    },
  );

  it('refuses a bare word: some are public TLDs', () => {
    expect(isLocalControllerHost('local')).toBe(false);
    expect(isLocalControllerHost('home')).toBe(false);
    expect(isLocalControllerHost('ai')).toBe(false);
  });
});
