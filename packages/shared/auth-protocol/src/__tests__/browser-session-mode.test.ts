import { describe, expect, it } from 'vitest';
import { BROWSER_SESSION_MODE_ENV, BROWSER_SESSION_MODES, parseBrowserSessionMode } from '../browser-session-mode';

describe('parseBrowserSessionMode', () => {
  it('names the one switch and its two values', () => {
    expect(BROWSER_SESSION_MODE_ENV).toBe('AUTH_BROWSER_SESSION_MODE');
    expect(BROWSER_SESSION_MODES).toEqual(['legacy', 'better-auth']);
  });

  it.each(BROWSER_SESSION_MODES)('reads %s', (mode) => {
    expect(parseBrowserSessionMode(mode)).toBe(mode);
  });

  it.each([undefined, ''])('reads %j as legacy', (rawMode) => {
    expect(parseBrowserSessionMode(rawMode)).toBe('legacy');
  });

  // A typo must stop the deploy, never quietly pick a mode.
  it.each(['   ', 'Legacy', 'BETTER-AUTH', ' better-auth', 'better_auth', 'betterauth', 'on', 'off', 'true', '1'])(
    'refuses %j',
    (rawMode) => {
      expect(() => parseBrowserSessionMode(rawMode)).toThrow('AUTH_BROWSER_SESSION_MODE_INVALID');
    },
  );

  it('keeps the refused value out of the error', () => {
    expect(() => parseBrowserSessionMode('secret-looking-value')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-looking-value') }),
    );
  });
});
