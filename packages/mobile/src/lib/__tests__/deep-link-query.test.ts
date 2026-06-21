import { describe, it, expect } from 'vitest';
import { parseDeepLinkQueryParams } from '../deep-link-query';

// This parser decodes the OAuth redirect deep links that drive the Strava
// connect flow (status/reason) — a regression here silently breaks onboarding,
// so the custom-scheme cases Hermes' URL handles badly are pinned explicitly.
describe('parseDeepLinkQueryParams', () => {
  it('parses params off a custom-scheme OAuth redirect', () => {
    const params = parseDeepLinkQueryParams('com.boardsesh.app://integrations/strava?status=connected');
    expect(params.get('status')).toBe('connected');
  });

  it('parses multiple params including the error reason', () => {
    const params = parseDeepLinkQueryParams(
      'com.boardsesh.app://integrations/strava?status=error&reason=missing_scope',
    );
    expect(params.get('status')).toBe('error');
    expect(params.get('reason')).toBe('missing_scope');
  });

  it('decodes percent-encoded values and plus-as-space', () => {
    const params = parseDeepLinkQueryParams('app://cb?name=J%C3%BCrgen&note=hello+world&path=a%2Fb');
    expect(params.get('name')).toBe('Jürgen');
    expect(params.get('note')).toBe('hello world');
    expect(params.get('path')).toBe('a/b');
  });

  it('ignores a hash fragment after the query', () => {
    const params = parseDeepLinkQueryParams('app://cb?status=connected#section');
    expect(params.get('status')).toBe('connected');
  });

  it('returns an empty map when there is no query string', () => {
    expect(parseDeepLinkQueryParams('com.boardsesh.app://integrations/strava').size).toBe(0);
    expect(parseDeepLinkQueryParams('').size).toBe(0);
  });

  it('handles bare keys and empty pairs without throwing', () => {
    const params = parseDeepLinkQueryParams('app://cb?flag&&status=ok&');
    expect(params.get('flag')).toBe('');
    expect(params.get('status')).toBe('ok');
  });

  it('skips pairs with malformed percent-encoding instead of failing the flow', () => {
    const params = parseDeepLinkQueryParams('app://cb?bad=%E0%A4%A&status=connected');
    expect(params.has('bad')).toBe(false);
    expect(params.get('status')).toBe('connected');
  });
});
