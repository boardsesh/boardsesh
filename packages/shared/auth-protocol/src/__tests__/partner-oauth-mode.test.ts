import { describe, expect, it } from 'vitest';
import { PARTNER_OAUTH_MODES, parsePartnerOAuthMode } from '../partner-oauth-mode';

describe('parsePartnerOAuthMode', () => {
  it.each(PARTNER_OAUTH_MODES)('reads %s', (mode) => {
    expect(parsePartnerOAuthMode(mode)).toBe(mode);
  });

  it.each([' Allowlist ', 'OPEN', 'hold\n'])('ignores case and surrounding spaces in %j', (rawMode) => {
    expect(parsePartnerOAuthMode(rawMode)).toBe(rawMode.trim().toLowerCase());
  });

  it.each([undefined, '', '   ', 'allowlst', 'on', 'true', '1', 'all ow list'])('reads %j as off', (rawMode) => {
    expect(parsePartnerOAuthMode(rawMode)).toBe('off');
  });
});
