/**
 * Domain matching for gym claims.
 *
 * A gym can be claimed by proving control of an email address at the gym's
 * website domain. These helpers derive the comparable domain from a stored
 * website URL and from a claimant's email, and decide whether they match.
 *
 * Matching is exact on the hostname (minus a leading `www.`) — controlling
 * `manager@bonsist.bg` claims `https://www.bonsist.bg`. We deliberately do NOT
 * treat one domain as a subdomain of another: proving control of a random
 * subdomain shouldn't grant a claim on the apex.
 */

/**
 * Common free/consumer email providers. A gym whose website domain is one of
 * these can't be claimed by domain proof (anyone can get such an address), so
 * those claims fall back to admin review.
 */
export const FREE_EMAIL_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'aol.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'mail.ru',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
  'tuta.io',
  'web.de',
  'qq.com',
  '163.com',
  '126.com',
  // ISP / country webmail
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'sfr.fr',
  'laposte.net',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.co.jp',
  'yahoo.es',
  'yahoo.it',
  'yahoo.ca',
  'yahoo.com.br',
  'yahoo.com.au',
  't-online.de',
  'gmx.at',
  'gmx.ch',
  'freenet.de',
  'libero.it',
  'virgilio.it',
  'seznam.cz',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'rediffmail.com',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'bell.net',
  'rogers.com',
  'shaw.ca',
  'telus.net',
  'bigpond.com',
  'btinternet.com',
  'ntlworld.com',
  'blueyonder.co.uk',
  'ukr.net',
  'inbox.ru',
  'bk.ru',
  'list.ru',
  // Shared website / page hosts — anyone can get a mailbox/subdomain here, so a
  // gym whose "website" is one of these can't be domain-proof claimed.
  'sites.google.com',
  'wixsite.com',
  'blogspot.com',
  'wordpress.com',
  'weebly.com',
  'squarespace.com',
  'godaddysites.com',
  'business.site',
  'myshopify.com',
  'github.io',
  'netlify.app',
  'vercel.app',
  'linktr.ee',
]);

/**
 * Extract the comparable domain from a website URL.
 *
 * Accepts bare hostnames (`bonsist.bg`) or full URLs (`https://www.Bonsist.BG/gym`),
 * lowercases, and strips a single leading `www.`. Returns null for empty or
 * unparseable input.
 */
export function extractDomain(websiteUrl: string | null | undefined): string | null {
  if (!websiteUrl) return null;
  const trimmed = websiteUrl.trim();
  if (!trimmed) return null;

  // Prepend a scheme so bare hostnames parse through the URL constructor.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  // A website URL must be http(s) — never javascript:/data:/etc. — and must not
  // carry userinfo (`https://victim.com@evil.com`), which would let the visible
  // host mislead a viewer while `hostname` resolves elsewhere.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const normalized = url.hostname.toLowerCase().replace(/^www\./, '');
  // A real domain has at least one dot (`example.com`); reject bare labels.
  if (!normalized || !normalized.includes('.')) return null;
  return normalized;
}

/**
 * Extract the lowercased domain from an email address, or null if malformed.
 */
export function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return null;
  // Strip a leading `www.` so it matches extractDomain (which strips it too),
  // otherwise `x@www.gym.com` would fail to verify against website `gym.com`.
  const domain = trimmed.slice(atIndex + 1).replace(/^www\./, '');
  if (!domain.includes('.') || /\s/.test(domain)) return null;
  return domain;
}

/**
 * Whether a domain is (a subdomain of) a free/consumer provider or shared host.
 * Subdomain-aware so shared page hosts like `mygym.wixsite.com` are caught, not
 * just the bare `wixsite.com`. `notgmail.com` does NOT match `gmail.com` (the
 * dot boundary is required).
 */
function isFreeProviderDomain(domain: string): boolean {
  for (const provider of FREE_EMAIL_PROVIDERS) {
    if (domain === provider || domain.endsWith(`.${provider}`)) return true;
  }
  return false;
}

/**
 * Whether a website's domain is usable for domain-proof claims: it parses to a
 * real domain and isn't a free/consumer email provider or shared page host.
 */
export function isClaimableDomain(websiteUrl: string | null | undefined): boolean {
  const domain = extractDomain(websiteUrl);
  return domain !== null && !isFreeProviderDomain(domain);
}

/**
 * Whether the claimant's email proves control of the gym's website domain:
 * the website has a usable (non-free) domain and the email's domain matches it
 * exactly (after normalizing `www.`).
 */
export function emailDomainMatchesWebsite(
  email: string | null | undefined,
  websiteUrl: string | null | undefined,
): boolean {
  if (!isClaimableDomain(websiteUrl)) return false;
  const websiteDomain = extractDomain(websiteUrl);
  const emailDomain = extractEmailDomain(email);
  if (!websiteDomain || !emailDomain) return false;
  if (isFreeProviderDomain(emailDomain)) return false;
  return emailDomain === websiteDomain;
}
