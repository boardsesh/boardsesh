// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SupportContent from '../support-content';
import type { SupportPageOptions } from '../support-links';

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

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('@/app/lib/analytics', () => analytics);

const preferences = vi.hoisted(() => ({
  getPreference: vi.fn(async (_key: string): Promise<unknown> => null),
  setPreference: vi.fn(async (_key: string, _value: unknown): Promise<void> => {}),
}));
vi.mock('@/app/lib/user-preferences-db', () => preferences);

const STRIPE_URL = 'https://donate.stripe.com/test_link';

/** The page as it was before monthly links: one optional one-off AUD link. */
function fallbackOptions(onceUrl?: string): SupportPageOptions {
  return {
    monthly: {},
    once: onceUrl ? { aud: onceUrl } : {},
    currencies: onceUrl ? ['aud'] : [],
    defaultCurrency: 'aud',
    monthlyFirst: false,
  };
}

// Placeholder labels: real ones come from the Railway env and name amounts.
const MONTHLY_OPTIONS: SupportPageOptions = {
  monthly: {
    aud: [
      { label: 'AUD tier A', url: 'https://buy.stripe.com/aud_a?client_reference_id=web-support' },
      { label: 'AUD tier B', url: 'https://buy.stripe.com/aud_b?client_reference_id=web-support' },
    ],
    usd: [{ label: 'USD tier A', url: 'https://buy.stripe.com/usd_a?client_reference_id=web-support' }],
  },
  once: { aud: 'https://buy.stripe.com/aud_once?client_reference_id=web-support' },
  currencies: ['aud', 'usd'],
  defaultCurrency: 'aud',
  billingPortalUrl: 'https://billing.stripe.com/p/login/test',
  monthlyFirst: true,
};

/** A monthly button's text: the env label inside the localized per-month template. */
function perMonth(label: string): string {
  return tFromCatalog('marketing', 'support.chooser.perMonth', { amount: label });
}

function renderPage(options: SupportPageOptions = fallbackOptions(), thanks = false) {
  return render(<SupportContent options={options} src="web-support" thanks={thanks} />);
}

function hrefs(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
}

describe('SupportContent', () => {
  it('renders the hero and the reason the page exists', () => {
    renderPage();

    expect(screen.getByText(tFromCatalog('marketing', 'support.hero.title'))).toBeTruthy();
    expect(screen.getByText(tFromCatalog('marketing', 'support.why.p1'))).toBeTruthy();
  });

  // The recurring rail is unconditional: GitHub Sponsors needs no env var.
  it('always offers the GitHub Sponsors rail', () => {
    const { container } = renderPage();

    expect(hrefs(container)).toContain('https://github.com/sponsors/boardsesh');
  });

  // Most environments have no Stripe Payment Link yet; a rendered card would be
  // a button that goes nowhere.
  it('hides the one-time donation rail when no Stripe link is configured', () => {
    renderPage();

    expect(screen.queryByTestId('support-one-time-rail')).toBeNull();
  });

  it('shows the one-time donation rail pointed at the configured Stripe link', () => {
    const { container } = renderPage(fallbackOptions(STRIPE_URL));

    expect(screen.getByTestId('support-one-time-rail')).toBeTruthy();
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
    const { container } = renderPage();

    expect(container.textContent).toMatch(/not tax-deductible/i);
  });

  // No perks, ever — a donation must never read as buying something.
  it('never promises anything in return for a donation', () => {
    const { container } = renderPage(fallbackOptions(STRIPE_URL));

    expect(container.textContent).not.toMatch(/unlock|early access|priority support|perk/i);
  });

  // The page is indexable, so it owes a crawler exactly one h1 carrying the
  // thing people search for. PageShell renders it; a page must not add a second
  // heading above it (the in-page header bar that used to sit there was the
  // reason this test exists).
  it('gives the hero the only h1 on the page', () => {
    const { container } = renderPage();

    const headings = Array.from(container.querySelectorAll('h1'));
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(tFromCatalog('marketing', 'support.hero.title'));
  });

  // The SEO rules want 2-3 crawlable internal links with descriptive anchor
  // text on every indexable page; the footer supplies the rest.
  it('links onward to /about and /docs for the internal-link rule', () => {
    const { container } = renderPage();

    expect(hrefs(container)).toContain('/about');
    expect(hrefs(container)).toContain('/docs');
  });
  describe('monthly first', () => {
    it('leads with monthly and lists every env-configured option', () => {
      renderPage(MONTHLY_OPTIONS);

      const options = screen.getByTestId('support-monthly-options');
      expect(options.textContent).toContain('AUD tier A');
      expect(options.textContent).toContain('AUD tier B');
      expect(screen.queryByTestId('support-one-time-rail')).toBeNull();
    });

    // The env label is the amount only; the cadence wording is the locale's.
    it('wraps each label in the localized per-month template', () => {
      renderPage(MONTHLY_OPTIONS);

      const buttons = Array.from(screen.getByTestId('support-monthly-options').querySelectorAll('a'));
      expect(buttons.map((button) => button.textContent)).toEqual([perMonth('AUD tier A'), perMonth('AUD tier B')]);
      expect(perMonth('AUD tier A')).toBe('AUD tier A/month');
    });

    // The monthly ask is for build time. No line beside it may pitch the bills.
    it('swaps every running-costs line for its build-time variant', () => {
      const { container } = renderPage(MONTHLY_OPTIONS);

      for (const key of ['support.promiseMonthly', 'support.why.p2Monthly', 'support.honesty.p1Monthly']) {
        expect(screen.getByText(tFromCatalog('marketing', key))).toBeTruthy();
      }
      for (const key of [
        'support.promise',
        'support.why.p2',
        'support.honesty.p1',
        'support.why.p1',
        'support.honesty.p2',
      ]) {
        expect(container.textContent).not.toContain(tFromCatalog('marketing', key));
      }
      expect(container.textContent).not.toMatch(/server bill|pays the bill|keeps the lights on/i);
    });

    // GitHub Sponsors stays as the third way to give.
    it('keeps GitHub Sponsors beside the chooser', () => {
      const { container } = renderPage(MONTHLY_OPTIONS);

      expect(screen.getByTestId('support-sponsors-rail')).toBeTruthy();
      expect(hrefs(container)).toContain('https://github.com/sponsors/boardsesh');
    });

    it('switches to the USD list', () => {
      renderPage(MONTHLY_OPTIONS);

      fireEvent.click(screen.getByTestId('support-currency-usd'));

      const options = screen.getByTestId('support-monthly-options');
      expect(options.textContent).toContain('USD tier A');
      expect(options.textContent).not.toContain('AUD tier A');
    });

    it('opens on the currency the server picked', () => {
      renderPage({ ...MONTHLY_OPTIONS, defaultCurrency: 'usd' });

      expect(screen.getByTestId('support-monthly-options').textContent).toContain('USD tier A');
    });

    it('offers Give once beside Monthly', () => {
      const { container } = renderPage(MONTHLY_OPTIONS);

      fireEvent.click(screen.getByText(tFromCatalog('marketing', 'support.chooser.once')));

      expect(screen.getByTestId('support-once-cta')).toBeTruthy();
      expect(hrefs(container)).toContain(MONTHLY_OPTIONS.once.aud ?? '');
    });

    it('says a name given at checkout may be shown publicly', () => {
      renderPage(MONTHLY_OPTIONS);

      expect(screen.getByText(tFromCatalog('marketing', 'support.chooser.publicName'))).toBeTruthy();
    });

    // The click event names the cadence, currency, position and src, and never
    // the label: labels name amounts.
    it('tracks a monthly click without its label', () => {
      analytics.track.mockClear();
      renderPage(MONTHLY_OPTIONS);

      fireEvent.click(screen.getByText(perMonth('AUD tier B')));

      expect(analytics.track).toHaveBeenCalledWith('Support CTA Clicked', {
        cadence: 'monthly',
        currency: 'aud',
        src: 'web-support',
        option: 2,
        placement: 'options',
      });
      expect(JSON.stringify(analytics.track.mock.calls)).not.toContain('tier');
    });

    it('still promises nothing in return', () => {
      const { container } = renderPage(MONTHLY_OPTIONS);

      expect(container.textContent).toMatch(/not tax-deductible/i);
      expect(container.textContent).not.toMatch(/unlock|early access|priority support|perk/i);
    });
  });

  it('tracks a GitHub Sponsors click in the fallback layout', () => {
    analytics.track.mockClear();
    renderPage();

    fireEvent.click(screen.getAllByText(tFromCatalog('marketing', 'support.sponsors.cta'))[0]!);

    expect(analytics.track).toHaveBeenCalledWith(
      'Support CTA Clicked',
      expect.objectContaining({ cadence: 'sponsors', currency: 'none', src: 'web-support' }),
    );
  });

  it('thanks a giver Stripe sent back with ?thanks=1', () => {
    renderPage(fallbackOptions(), true);

    expect(screen.getByTestId('support-thanks')).toBeTruthy();
  });

  // Someone who just gave is not asked again by the homepage's December banner.
  it('closes the December banner for good on the thank-you visit', () => {
    preferences.setPreference.mockClear();
    renderPage(fallbackOptions(), true);

    expect(preferences.setPreference).toHaveBeenCalledWith('supportBanner:december2026:dismissed', true);
  });

  it('shows no thank-you on a normal visit and leaves the banner alone', () => {
    preferences.setPreference.mockClear();
    renderPage();

    expect(screen.queryByTestId('support-thanks')).toBeNull();
    expect(preferences.setPreference).not.toHaveBeenCalled();
  });
});
