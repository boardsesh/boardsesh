// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const { authState, request } = vi.hoisted(() => ({
  authState: { token: null as string | null, isAuthenticated: false, isLoading: false, error: null as string | null },
  request: vi.fn(),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => authState }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request }) }));

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
  beforeEach(() => {
    Object.assign(authState, { token: null, isAuthenticated: false, isLoading: false, error: null });
    request.mockReset();
  });

  function checkoutContent(initialStatus = EMPTY_STATUS) {
    return (
      <SupportContent
        configuration={{ enabled: true, currency: 'USD', minimumAmount: 100, maximumAmount: 50_000 }}
        initialStatus={initialStatus}
        locale="en-US"
      />
    );
  }

  it.each([{ isLoading: true }, { error: 'Token request failed' }, { isAuthenticated: true }])(
    'blocks Checkout while authentication is unresolved: %j',
    (unresolvedAuth) => {
      Object.assign(authState, unresolvedAuth);
      render(checkoutContent());
      const checkoutButton = screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') });
      expect(checkoutButton.hasAttribute('disabled')).toBe(true);
      fireEvent.click(checkoutButton);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('blocks supporter account controls until the signed-in token resolves', () => {
    Object.assign(authState, { isAuthenticated: true, isLoading: true });
    render(checkoutContent({ ...EMPTY_STATUS, hasSupported: true, hasActiveSubscription: true }));
    const visibility = screen.getByRole('checkbox', { name: tFromCatalog('marketing', 'support.manage.publicCredit') });
    expect((visibility as HTMLInputElement).disabled).toBe(true);
    for (const billingButton of screen.getAllByRole('button', {
      name: tFromCatalog('marketing', 'support.manage.billing'),
    })) {
      expect(billingButton.hasAttribute('disabled')).toBe(true);
      fireEvent.click(billingButton);
    }
    fireEvent.click(visibility);
    expect(request).not.toHaveBeenCalled();
  });

  it('allows resolved anonymous Checkout and always sends private credit', async () => {
    request.mockRejectedValue(new Error('Stop before navigation'));
    render(checkoutContent({ ...EMPTY_STATUS, showPublicly: true }));
    const checkoutButton = screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') });
    expect(checkoutButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(checkoutButton);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(expect.anything(), {
        input: { amount: 500, cadence: 'MONTHLY', publicCredit: false, locale: 'en-US' },
      }),
    );
  });

  it('keeps future Checkout credit in sync with saved supporter visibility', async () => {
    Object.assign(authState, { token: 'account-token', isAuthenticated: true });
    request.mockResolvedValueOnce({
      updateSupporterVisibility: { ...EMPTY_STATUS, hasSupported: true, showPublicly: true },
    });
    render(checkoutContent({ ...EMPTY_STATUS, hasSupported: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: tFromCatalog('marketing', 'support.manage.publicCredit') }));
    const checkoutCredit = screen.getByRole('checkbox', {
      name: tFromCatalog('marketing', 'support.stripe.publicCredit'),
    });
    await waitFor(() => expect((checkoutCredit as HTMLInputElement).checked).toBe(true));
    request.mockRejectedValueOnce(new Error('Stop before navigation'));
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(expect.anything(), {
        input: { amount: 500, cadence: 'MONTHLY', publicCredit: true, locale: 'en-US' },
      }),
    );
  });

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
