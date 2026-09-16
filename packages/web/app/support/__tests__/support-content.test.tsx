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

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const STRIPE_URL = 'https://donate.stripe.com/test_link';

function hrefs(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
}

describe('SupportContent', () => {
  it('renders the hero and the reason the page exists', () => {
    render(<SupportContent stripeDonateUrl={undefined} />);

    expect(screen.getByText(tFromCatalog('marketing', 'support.hero.title'))).toBeTruthy();
    expect(screen.getByText(tFromCatalog('marketing', 'support.why.p1'))).toBeTruthy();
  });

  // The recurring rail is unconditional: GitHub Sponsors needs no env var.
  it('always offers the GitHub Sponsors rail', () => {
    const { container } = render(<SupportContent stripeDonateUrl={undefined} />);

    expect(hrefs(container)).toContain('https://github.com/sponsors/boardsesh');
  });

  // Most environments have no Stripe Payment Link yet; a rendered card would be
  // a button that goes nowhere.
  it('hides the one-time donation rail when no Stripe link is configured', () => {
    render(<SupportContent stripeDonateUrl={undefined} />);

    expect(screen.queryByTestId('support-one-time-rail')).toBeNull();
  });

  it('shows the one-time donation rail pointed at the configured Stripe link', () => {
    const { container } = render(<SupportContent stripeDonateUrl={STRIPE_URL} />);

    expect(screen.getByTestId('support-one-time-rail')).toBeTruthy();
    expect(hrefs(container)).toContain(STRIPE_URL);
  });

  // Donations buy nothing, and the page has to say so — the "not tax-deductible"
  // line is a legal obligation, not copy taste.
  it('states that donations are not tax-deductible', () => {
    render(<SupportContent stripeDonateUrl={undefined} />);

    expect(screen.getByText(tFromCatalog('marketing', 'support.honesty.p1'))).toBeTruthy();
  });

  // The page is indexable, so it owes a crawler exactly one h1 carrying the
  // thing people search for. `/about` renders its hero as an h2 and has none.
  it('gives the hero the only h1 on the page', () => {
    const { container } = render(<SupportContent stripeDonateUrl={undefined} />);

    const headings = Array.from(container.querySelectorAll('h1'));
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(tFromCatalog('marketing', 'support.hero.title'));
  });

  it('links onward to /about for the internal-link rule', () => {
    const { container } = render(<SupportContent stripeDonateUrl={undefined} />);

    expect(hrefs(container)).toContain('/about');
  });
});
