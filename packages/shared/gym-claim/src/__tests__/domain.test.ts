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
});

describe('extractEmailDomain', () => {
  it('extracts the lowercased domain', () => {
    expect(extractEmailDomain('Manager@Bonsist.BG')).toBe('bonsist.bg');
    expect(extractEmailDomain('a.b+tag@sub.example.com')).toBe('sub.example.com');
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
