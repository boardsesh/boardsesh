import { describe, it, expect } from 'vitest';
import {
  extractDomain,
  extractEmailDomain,
  isClaimableDomain,
  emailDomainMatchesWebsite,
  FREE_EMAIL_PROVIDERS,
} from '../domain';

describe('extractDomain', () => {
  it('handles full URLs, bare hosts, casing, paths, and www', () => {
    expect(extractDomain('https://www.bonsist.bg')).toBe('bonsist.bg');
    expect(extractDomain('http://bonsist.bg/gym/sofia')).toBe('bonsist.bg');
    expect(extractDomain('bonsist.bg')).toBe('bonsist.bg');
    expect(extractDomain('www.Bonsist.BG')).toBe('bonsist.bg');
    expect(extractDomain('https://climb.example.com')).toBe('climb.example.com');
    expect(extractDomain('  https://example.com  ')).toBe('example.com');
  });

  it('returns null for empty, bare labels, or garbage', () => {
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain(undefined)).toBeNull();
    expect(extractDomain('')).toBeNull();
    expect(extractDomain('   ')).toBeNull();
    expect(extractDomain('localhost')).toBeNull();
    expect(extractDomain('not a url')).toBeNull();
  });

  it('rejects userinfo and non-http(s) schemes (defense-in-depth)', () => {
    // Userinfo could mislead a viewer while hostname resolves elsewhere.
    expect(extractDomain('https://victim.com@evil.com')).toBeNull();
    expect(extractDomain('https://user:pass@gym.com')).toBeNull();
    // Only http(s) is a real website.
    expect(extractDomain('javascript:alert(1)')).toBeNull();
    expect(extractDomain('data:text/html,x')).toBeNull();
    expect(extractDomain('ftp://gym.com')).toBeNull();
    expect(extractDomain('mailto:owner@gym.com')).toBeNull();
  });

  it('strips ports and query/fragment, and is case-insensitive on the scheme', () => {
    // Parsed by hand (no URL constructor) so it also runs on React Native.
    expect(extractDomain('https://gym.com:8080/path')).toBe('gym.com');
    expect(extractDomain('HTTPS://www.Gym.com')).toBe('gym.com');
    expect(extractDomain('gym.com?ref=x')).toBe('gym.com');
    expect(extractDomain('http://gym.com#top')).toBe('gym.com');
  });
});

describe('extractEmailDomain', () => {
  it('extracts the lowercased domain', () => {
    expect(extractEmailDomain('Manager@Bonsist.BG')).toBe('bonsist.bg');
    expect(extractEmailDomain('a.b+tag@sub.example.com')).toBe('sub.example.com');
  });

  it('strips a leading www. for parity with extractDomain', () => {
    expect(extractEmailDomain('x@www.gym.com')).toBe('gym.com');
  });

  it('returns null for malformed addresses', () => {
    expect(extractEmailDomain('no-at-sign')).toBeNull();
    expect(extractEmailDomain('@example.com')).toBeNull();
    expect(extractEmailDomain('user@')).toBeNull();
    expect(extractEmailDomain('user@localhost')).toBeNull();
    expect(extractEmailDomain(null)).toBeNull();
  });
});

describe('isClaimableDomain', () => {
  it('is true for a real company domain', () => {
    expect(isClaimableDomain('https://www.bonsist.bg')).toBe(true);
  });

  it('is false when there is no website', () => {
    expect(isClaimableDomain(null)).toBe(false);
    expect(isClaimableDomain('')).toBe(false);
  });

  it('is false for free email providers set as a website', () => {
    expect(isClaimableDomain('https://gmail.com')).toBe(false);
    expect(isClaimableDomain('gmail.com')).toBe(false);
    expect(isClaimableDomain('www.yahoo.com')).toBe(false);
  });

  it('is false for ISP webmail and shared page hosts', () => {
    expect(isClaimableDomain('https://comcast.net')).toBe(false);
    expect(isClaimableDomain('orange.fr')).toBe(false);
    expect(isClaimableDomain('https://sites.google.com')).toBe(false);
    expect(isClaimableDomain('mygym.wixsite.com')).toBe(false);
  });
});

describe('emailDomainMatchesWebsite', () => {
  it('matches an exact domain email against the website', () => {
    expect(emailDomainMatchesWebsite('manager@bonsist.bg', 'https://www.bonsist.bg')).toBe(true);
    expect(emailDomainMatchesWebsite('Manager@Bonsist.BG', 'bonsist.bg')).toBe(true);
  });

  it('rejects a different domain', () => {
    expect(emailDomainMatchesWebsite('manager@other.bg', 'https://www.bonsist.bg')).toBe(false);
  });

  it('rejects a subdomain of the website (must be exact)', () => {
    expect(emailDomainMatchesWebsite('manager@mail.bonsist.bg', 'https://www.bonsist.bg')).toBe(false);
  });

  it('rejects when the website is a free provider even if the email matches it', () => {
    expect(emailDomainMatchesWebsite('someone@gmail.com', 'https://gmail.com')).toBe(false);
  });

  it('rejects when there is no website on file', () => {
    expect(emailDomainMatchesWebsite('manager@bonsist.bg', null)).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(emailDomainMatchesWebsite('not-an-email', 'https://www.bonsist.bg')).toBe(false);
  });
});

describe('FREE_EMAIL_PROVIDERS', () => {
  it('includes the common consumer providers', () => {
    expect(FREE_EMAIL_PROVIDERS.has('gmail.com')).toBe(true);
    expect(FREE_EMAIL_PROVIDERS.has('outlook.com')).toBe(true);
    expect(FREE_EMAIL_PROVIDERS.has('icloud.com')).toBe(true);
  });
});
