// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SupportContent from '../support-content';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/support',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: null, isAuthenticated: false, isLoading: false, error: null }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const STRIPE_URL = 'https://donate.stripe.com/test_link';
const EMPTY_STATUS = {
  linked: false,
  hasSupported: false,
  showPublicly: false,
  hasActiveSubscription: false,
  cancelAtPeriodEnd: false,
};

function supportContent(legacyDonateUrl?: string) {
  return (
    <SupportContent
      configuration={{
        enabled: false,
        currency: 'USD',
        minimumAmount: 100,
        maximumAmount: 50_000,
        legacyDonateUrl,
      }}
      initialStatus={EMPTY_STATUS}
      locale="en-US"
    />
  );
}

function hrefs(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
}

describe('SupportContent', () => {
  it('renders the hero and the reason the page exists', () => {
    render(supportContent());

    expect(screen.getByText(tFromCatalog('marketing', 'support.hero.title'))).toBeTruthy();
    expect(screen.getByText(tFromCatalog('marketing', 'support.why.p1'))).toBeTruthy();
  });

  // The recurring rail is unconditional: GitHub Sponsors needs no env var.
  it('always offers the GitHub Sponsors rail', () => {
    const { container } = render(supportContent());

    expect(hrefs(container)).toContain('https://github.com/sponsors/boardsesh');
  });

  it('keeps Stripe first even when Checkout is unavailable', () => {
    render(supportContent());

    expect(screen.getByTestId('stripe-support-rail')).toBeTruthy();
    expect(screen.getByText(tFromCatalog('marketing', 'support.stripe.unavailable'))).toBeTruthy();
  });

  it('uses the legacy Stripe link while backend Checkout is unavailable', () => {
    const { container } = render(supportContent(STRIPE_URL));

    expect(hrefs(container)).toContain(STRIPE_URL);
  });

  // Donations buy nothing, and the page has to say so — the "not tax-deductible"
  // line is a legal obligation, not copy taste.
  //
  // Asserted on the LITERAL phrase, not on `tFromCatalog('support.honesty.p1')`:
  // resolving the same key the component renders would pass against any copy at
  // all, including copy that dropped the disclosure. Every locale's wording is
  // pinned in `@boardsesh/i18n`'s `donation-disclosure.test.ts`.
  it('states that donations are not tax-deductible', () => {
    const { container } = render(supportContent());

    expect(container.textContent).toMatch(/not tax-deductible/i);
  });

  // No perks, ever — a donation must never read as buying something.
  it('never promises anything in return for a donation', () => {
    const { container } = render(supportContent(STRIPE_URL));

    expect(container.textContent).not.toMatch(/unlock|early access|priority support|perk/i);
  });

  // The page is indexable, so it owes a crawler exactly one h1 carrying the
  // thing people search for. PageShell renders it; a page must not add a second
  // heading above it (the in-page header bar that used to sit there was the
  // reason this test exists).
  it('gives the hero the only h1 on the page', () => {
    const { container } = render(supportContent());

    const headings = Array.from(container.querySelectorAll('h1'));
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(tFromCatalog('marketing', 'support.hero.title'));
  });

  // The SEO rules want 2-3 crawlable internal links with descriptive anchor
  // text on every indexable page; the footer supplies the rest.
  it('links onward to /about and /docs for the internal-link rule', () => {
    const { container } = render(supportContent());

    expect(hrefs(container)).toContain('/about');
    expect(hrefs(container)).toContain('/docs');
  });
});
