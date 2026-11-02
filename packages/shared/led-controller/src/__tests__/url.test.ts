import { describe, expect, it } from 'vitest';
import { normalizeControllerUrl } from '../url';

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
