import { describe, expect, it } from 'vitest';
import { resolveWebHeadOrigin, resolveWebPlatforms } from '../../app.config';

describe('resolveWebPlatforms', () => {
  it('preserves the mobile-only config when the flag is unset', () => {
    const resolution = resolveWebPlatforms(undefined);

    expect(resolution).toEqual({ platforms: ['ios', 'android'] });
    expect('web' in resolution).toBe(false);
    expect('baseUrl' in resolution).toBe(false);
  });

  it.each(['', '0', 'true', 'web', ' 1'])('does not enable web for %j', (envValue) => {
    expect(resolveWebPlatforms(envValue)).toEqual({ platforms: ['ios', 'android'] });
  });

  it('enables a single-page Metro export rooted at /app', () => {
    expect(resolveWebPlatforms('1')).toEqual({
      platforms: ['ios', 'android', 'web'],
      web: { output: 'single', bundler: 'metro' },
      baseUrl: '/app',
    });
  });
});

describe('resolveWebHeadOrigin', () => {
  it('is absent from native config when web is disabled', () => {
    expect(resolveWebHeadOrigin(undefined, 'https://example.test:3000/app')).toBeUndefined();
  });

  it('allows Metro requests from the public same-origin web host', () => {
    expect(resolveWebHeadOrigin('1', 'https://example.test:3000/app')).toBe('https://example.test:3000');
  });

  it('rejects non-HTTP public origins', () => {
    expect(() => resolveWebHeadOrigin('1', 'file:///tmp/app')).toThrow(/http or https/);
  });
});
