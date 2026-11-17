import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import * as page from '../developers-docs-samples';

// The page states numbers the backend owns, and none of them lives in a package
// the web may import. Reading the backend source here (never importing it into
// the bundle) makes a changed constant fail this test instead of going stale.
const BACKEND = join(import.meta.dirname, '..', '..', '..', '..', 'backend', 'src');

function source(relativePath: string): string {
  return readFileSync(join(BACKEND, relativePath), 'utf8');
}

function constant(text: string, name: string): number {
  const match = new RegExp(`\\b${name}\\s*[=:]\\s*(\\d+)\\s*[;,]`).exec(text);
  if (!match) throw new Error(`${name} not found in the backend source`);
  return Number(match[1]);
}

describe('developer docs numbers match the backend', () => {
  const rules = source('auth/partner/registration-rules.ts');
  const authority = source('auth/partner/authority.ts');
  const configuration = source('auth/partner/configuration.ts');
  const router = source('handlers/public-api/router.ts');
  const partnerAuth = source('handlers/partner-auth.ts');

  it('registration caps', () => {
    expect(page.APPS_PER_DEVELOPER).toBe(constant(rules, 'PARTNER_APPS_PER_DEVELOPER'));
    expect(page.REDIRECT_URIS_PER_APP).toBe(constant(rules, 'PARTNER_REDIRECT_URIS_PER_APP'));
    expect(page.EARLY_ACCESS_LIVE_CLIMBERS).toBe(constant(rules, 'PARTNER_LAUNCH_MAX_ACTIVE_CONNECTIONS'));
    expect(page.EARLY_ACCESS_NEW_PER_DAY).toBe(constant(rules, 'PARTNER_LAUNCH_MAX_NEW_CONNECTIONS_PER_DAY'));
  });

  it('token lifetimes', () => {
    expect(page.ACCESS_TOKEN_SECONDS).toBe(constant(authority, 'accessTokenExpiresIn'));
    const refresh = /refreshTokenExpiresIn:\s*(\d+) \* 24 \* 60 \* 60/.exec(authority);
    expect(page.REFRESH_TOKEN_DAYS).toBe(Number(refresh?.[1]));
    expect(page.CODE_SECONDS).toBe(constant(configuration, 'PARTNER_AUTHORIZATION_CODE_LIFETIME_SECONDS'));
  });

  it('request limits', () => {
    expect(page.API_PER_CLIMBER).toBe(constant(router, 'API_PER_CONNECTION'));
    expect(page.API_PER_APP).toBe(constant(router, 'API_PER_APP'));
    expect(page.TOKEN_EXCHANGE_PER_APP_AND_IP).toBe(constant(partnerAuth, 'TOKEN_PER_APP_AND_IP'));
    expect(page.REFRESH_PER_CLIMBER).toBe(constant(partnerAuth, 'REFRESH_PER_CONNECTION'));
  });
});
