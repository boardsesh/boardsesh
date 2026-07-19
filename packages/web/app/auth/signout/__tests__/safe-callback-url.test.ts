import { describe, expect, it } from 'vite-plus/test';
import { safeCallbackUrl } from '../safe-callback-url';

describe('safeCallbackUrl', () => {
  it('keeps a same-origin relative path', () => {
    expect(safeCallbackUrl('/app')).toBe('/app');
    expect(safeCallbackUrl('/app/play?x=1#frag')).toBe('/app/play?x=1#frag');
    expect(safeCallbackUrl('/')).toBe('/');
  });

  it('rejects a protocol-relative URL', () => {
    expect(safeCallbackUrl('//evil.com')).toBe('/');
    expect(safeCallbackUrl('//evil.com/app')).toBe('/');
  });

  it('rejects the backslash protocol-relative variant browsers normalise to //', () => {
    expect(safeCallbackUrl('/\\evil.com')).toBe('/');
    expect(safeCallbackUrl('/\\/evil.com')).toBe('/');
  });

  it('rejects an absolute URL', () => {
    expect(safeCallbackUrl('https://evil.com')).toBe('/');
    expect(safeCallbackUrl('http://evil.com/app')).toBe('/');
  });

  it('rejects a javascript: (and other non-path) scheme', () => {
    expect(safeCallbackUrl('javascript:alert(1)')).toBe('/');
    expect(safeCallbackUrl('data:text/html,x')).toBe('/');
    expect(safeCallbackUrl('mailto:a@b.com')).toBe('/');
  });

  it('rejects empty, null, undefined, and non-path values', () => {
    expect(safeCallbackUrl(null)).toBe('/');
    expect(safeCallbackUrl(undefined)).toBe('/');
    expect(safeCallbackUrl('')).toBe('/');
    expect(safeCallbackUrl('app/play')).toBe('/');
    expect(safeCallbackUrl(' /app')).toBe('/');
  });
});
