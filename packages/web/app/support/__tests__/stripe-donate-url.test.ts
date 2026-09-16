import { describe, it, expect } from 'vite-plus/test';
import { resolveStripeDonateUrl } from '../stripe-donate-url';

/**
 * The one-time donation rail on `/support` renders only when this resolves.
 *
 * The var is read at request time from the Railway web service's environment,
 * NOT baked in at build time: a `NEXT_PUBLIC_` name would be inlined during the
 * image build, and neither `Dockerfile.web` nor `production-deploy.yml` passes
 * one as a build arg, so a prefixed var could never be set in production.
 */
describe('resolveStripeDonateUrl', () => {
  it('passes an https Payment Link through', () => {
    expect(resolveStripeDonateUrl('https://donate.stripe.com/abc123')).toBe('https://donate.stripe.com/abc123');
  });

  it('treats an unset var as no rail', () => {
    expect(resolveStripeDonateUrl(undefined)).toBeUndefined();
  });

  it('treats an empty var as no rail', () => {
    expect(resolveStripeDonateUrl('')).toBeUndefined();
  });

  // A misconfigured value must hide the rail, never point a donate button
  // somewhere else — these are the shapes a fat-fingered env var actually takes.
  it.each(['http://donate.stripe.com/abc123', '//donate.stripe.com/abc123', 'donate.stripe.com/abc123', 'true'])(
    'refuses %s rather than linking it',
    (rawValue) => {
      expect(resolveStripeDonateUrl(rawValue)).toBeUndefined();
    },
  );

  it('refuses a javascript: URL', () => {
    expect(resolveStripeDonateUrl('javascript:alert(1)')).toBeUndefined();
  });
});
