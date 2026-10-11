// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import SupportContent from '../support-content';
import { CREATE_SUPPORT_BILLING_PORTAL } from '@boardsesh/graphql/operations/support';

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

const { authState, request, refetchAuth } = vi.hoisted(() => ({
  authState: {
    token: null as string | null,
    isAuthenticated: false,
    isLoading: false,
    error: null as string | null,
    userId: 'user-1',
  },
  request: vi.fn(),
  refetchAuth: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: authState.isLoading ? 'loading' : authState.isAuthenticated ? 'authenticated' : 'unauthenticated',
    data: authState.isAuthenticated ? { user: { id: authState.userId } } : null,
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ ...authState, refetch: refetchAuth }) }));
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
      initialUserId={null}
      locale="en-US"
    />
  );
}

function hrefs(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
}

describe('SupportContent', () => {
  beforeEach(() => {
    Object.assign(authState, { token: null, isAuthenticated: false, isLoading: false, error: null, userId: 'user-1' });
    request.mockReset();
    refetchAuth.mockReset().mockResolvedValue(undefined);
  });

  function checkoutContent(initialStatus = EMPTY_STATUS) {
    return (
      <SupportContent
        configuration={{ enabled: true, currency: 'USD', minimumAmount: 100, maximumAmount: 50_000 }}
        initialStatus={initialStatus}
        initialUserId={authState.isAuthenticated || authState.isLoading ? authState.userId : null}
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

  it('explains an auth failure and retries before enabling Checkout', async () => {
    authState.error = 'Token request failed';
    const { rerender } = render(checkoutContent());
    expect(screen.getByRole('alert').textContent).toContain(tFromCatalog('marketing', 'support.stripe.authError'));
    const checkoutButton = screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') });
    expect(checkoutButton.hasAttribute('disabled')).toBe(true);
    refetchAuth.mockImplementation(async () => {
      Object.assign(authState, { error: null, token: 'account-token', isAuthenticated: true });
    });
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('common', 'actions.retry') }));
    await waitFor(() => expect(refetchAuth).toHaveBeenCalledTimes(1));
    rerender(checkoutContent());
    await waitFor(() => expect(checkoutButton.hasAttribute('disabled')).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps Checkout blocked while retrying and after another auth failure', async () => {
    authState.error = 'Token request failed';
    let finishRetry: (() => void) | undefined;
    refetchAuth.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRetry = resolve;
        }),
    );
    render(checkoutContent());
    const retryButton = screen.getByRole('button', { name: tFromCatalog('common', 'actions.retry') });
    const checkoutButton = screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') });
    fireEvent.click(retryButton);
    expect(retryButton.hasAttribute('disabled')).toBe(true);
    expect(checkoutButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(checkoutButton);
    fireEvent.click(retryButton);
    expect(refetchAuth).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      finishRetry?.();
    });
    await waitFor(() => expect(retryButton.hasAttribute('disabled')).toBe(false));
    expect(checkoutButton.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(tFromCatalog('marketing', 'support.stripe.authError'));
    fireEvent.click(checkoutButton);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['PENDING_CHECKOUT_EXISTS', 'support.stripe.pendingCheckout'],
    ['ACTIVE_SUBSCRIPTION_EXISTS', 'support.stripe.activeSubscription'],
    ['SUPPORT_OPERATION_PENDING', 'support.stripe.operationPending'],
    ['SUPPORT_OPERATION_STALE', 'support.stripe.operationStale'],
  ])('gives an actionable localized explanation for %s', async (code, messageKey) => {
    Object.assign(authState, { token: 'account-token', isAuthenticated: true });
    request.mockRejectedValue({ response: { errors: [{ message: 'Internal server wording', extensions: { code } }] } });
    render(checkoutContent());
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(tFromCatalog('marketing', messageKey)));
    expect(screen.getByRole('alert').textContent).not.toContain('Internal server wording');
  });

  it('offers the billing portal after a stale page discovers existing monthly support', async () => {
    Object.assign(authState, { token: 'account-token', isAuthenticated: true });
    request.mockRejectedValueOnce({ response: { errors: [{ extensions: { code: 'ACTIVE_SUBSCRIPTION_EXISTS' } }] } });
    render(checkoutContent());
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    const billingButton = await screen.findByRole('button', {
      name: tFromCatalog('marketing', 'support.manage.billing'),
    });
    await waitFor(() => expect(billingButton.hasAttribute('disabled')).toBe(false));
    request.mockRejectedValueOnce(new Error('Stop before navigation'));
    fireEvent.click(billingButton);
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(CREATE_SUPPORT_BILLING_PORTAL, { locale: 'en-US' }));
  });

  it.each([
    { response: { errors: [{ extensions: { code: 'UNKNOWN_CODE' } }] } },
    { response: { errors: [{ extensions: { code: 42 } }] } },
    { response: { errors: 'invalid' } },
    new Error('Opaque network failure'),
  ])('keeps unknown or malformed failures generic', async (requestError) => {
    request.mockRejectedValue(requestError);
    render(checkoutContent());
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(tFromCatalog('marketing', 'support.stripe.error')),
    );
  });

  it('clears prior billing, credit, and errors across sign-out and another account sign-in', async () => {
    Object.assign(authState, { token: 'token-A', isAuthenticated: true, userId: 'user-A' });
    const initialStatus = { ...EMPTY_STATUS, hasSupported: true, showPublicly: true };
    const { rerender } = render(checkoutContent(initialStatus));
    request.mockRejectedValueOnce({ response: { errors: [{ extensions: { code: 'ACTIVE_SUBSCRIPTION_EXISTS' } }] } });
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    await screen.findByRole('button', { name: tFromCatalog('marketing', 'support.manage.billing') });
    expect(screen.getByRole('alert')).toBeTruthy();
    Object.assign(authState, { token: null, isAuthenticated: false });
    rerender(checkoutContent(initialStatus));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: tFromCatalog('marketing', 'support.manage.billing') })).toBeNull();
    Object.assign(authState, { token: 'token-B', isAuthenticated: true, userId: 'user-B' });
    rerender(checkoutContent(initialStatus));
    const credit = screen.getByRole('checkbox', { name: tFromCatalog('marketing', 'support.stripe.publicCredit') });
    expect((credit as HTMLInputElement).checked).toBe(false);
    expect(
      screen.queryByRole('checkbox', { name: tFromCatalog('marketing', 'support.manage.publicCredit') }),
    ).toBeNull();
    request.mockRejectedValueOnce(new Error('Stop before navigation'));
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(expect.anything(), {
        input: { amount: 500, cadence: 'MONTHLY', publicCredit: false, locale: 'en-US' },
      }),
    );
  });

  it('ignores account A’s late visibility response after account B takes over', async () => {
    Object.assign(authState, { token: 'token-A', isAuthenticated: true, userId: 'user-A' });
    let finishA: ((response: unknown) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    const initialStatus = { ...EMPTY_STATUS, hasSupported: true };
    const { rerender } = render(checkoutContent(initialStatus));
    fireEvent.click(screen.getByRole('checkbox', { name: tFromCatalog('marketing', 'support.manage.publicCredit') }));
    Object.assign(authState, { token: 'token-B', userId: 'user-B' });
    rerender(checkoutContent(initialStatus));
    await act(async () => {
      finishA?.({ updateSupporterVisibility: { ...initialStatus, showPublicly: true, hasActiveSubscription: true } });
    });
    expect(
      screen.queryByRole('checkbox', { name: tFromCatalog('marketing', 'support.manage.publicCredit') }),
    ).toBeNull();
    expect(
      (
        screen.getByRole('checkbox', {
          name: tFromCatalog('marketing', 'support.stripe.publicCredit'),
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.queryByRole('button', { name: tFromCatalog('marketing', 'support.manage.billing') })).toBeNull();
  });

  it('ignores account A’s late billing error and keeps account B’s request busy', async () => {
    Object.assign(authState, { token: 'token-A', isAuthenticated: true, userId: 'user-A' });
    let failA: ((error: unknown) => void) | undefined;
    let failB: ((error: unknown) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failA = reject;
        }),
    );
    const { rerender } = render(checkoutContent());
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    Object.assign(authState, { token: 'token-B', userId: 'user-B' });
    rerender(checkoutContent());
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failB = reject;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.cta') }));
    await act(async () => {
      failA?.({ response: { errors: [{ extensions: { code: 'ACTIVE_SUBSCRIPTION_EXISTS' } }] } });
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: tFromCatalog('marketing', 'support.manage.billing') })).toBeNull();
    expect(
      screen
        .getByRole('button', { name: tFromCatalog('marketing', 'support.stripe.processing') })
        .hasAttribute('disabled'),
    ).toBe(true);
    await act(async () => {
      failB?.(new Error('Stop before navigation'));
    });
  });

  it('masks account A’s SSR billing when the first settled session belongs to B', () => {
    Object.assign(authState, { isLoading: true, userId: 'user-A' });
    const initialStatus = { ...EMPTY_STATUS, hasSupported: true, hasActiveSubscription: true, showPublicly: true };
    const { rerender } = render(checkoutContent(initialStatus));
    Object.assign(authState, { isLoading: false, isAuthenticated: true, token: 'token-B', userId: 'user-B' });
    rerender(checkoutContent(initialStatus));
    expect(screen.queryByRole('button', { name: tFromCatalog('marketing', 'support.manage.billing') })).toBeNull();
    expect(
      screen.queryByRole('checkbox', { name: tFromCatalog('marketing', 'support.manage.publicCredit') }),
    ).toBeNull();
    expect(
      (
        screen.getByRole('checkbox', {
          name: tFromCatalog('marketing', 'support.stripe.publicCredit'),
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it.each([
    ['createSupportCheckoutSession', 'support.stripe.cta', false],
    ['createSupportBillingPortalSession', 'support.manage.billing', true],
  ] as const)(
    'ignores account A’s late %s URL after a switch',
    async (responseField, buttonKey, activeSubscription) => {
      Object.assign(authState, { token: 'token-A', isAuthenticated: true, userId: 'user-A' });
      let finishA: ((response: unknown) => void) | undefined;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishA = resolve;
          }),
      );
      const initialStatus = {
        ...EMPTY_STATUS,
        hasSupported: activeSubscription,
        hasActiveSubscription: activeSubscription,
      };
      const { rerender } = render(checkoutContent(initialStatus));
      fireEvent.click(screen.getAllByRole('button', { name: tFromCatalog('marketing', buttonKey) })[0]);
      Object.assign(authState, { token: 'token-B', userId: 'user-B' });
      rerender(checkoutContent(initialStatus));
      const readSessionUrl = vi.fn(() => ({ url: 'https://stripe.test/account-A' }));
      const staleResponse = Object.defineProperty({}, responseField, { get: readSessionUrl });
      await act(async () => {
        finishA?.(staleResponse);
      });
      expect(readSessionUrl).not.toHaveBeenCalled();
    },
  );

  it('preserves server supporter state while the initial session loads', () => {
    Object.assign(authState, { isLoading: true });
    const initialStatus = { ...EMPTY_STATUS, hasSupported: true, hasActiveSubscription: true, showPublicly: true };
    const { rerender } = render(checkoutContent(initialStatus));
    expect(
      (
        screen.getByRole('checkbox', {
          name: tFromCatalog('marketing', 'support.manage.publicCredit'),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    Object.assign(authState, { isLoading: false, token: 'token-A', isAuthenticated: true });
    rerender(checkoutContent(initialStatus));
    expect(
      (
        screen.getByRole('checkbox', {
          name: tFromCatalog('marketing', 'support.manage.publicCredit'),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(screen.getAllByRole('button', { name: tFromCatalog('marketing', 'support.manage.billing') })).toHaveLength(
      2,
    );
  });

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

  it.each([false, true])(
    'preserves saved visibility %s after a failed update and permits retry',
    async (showPublicly) => {
      Object.assign(authState, { token: 'account-token', isAuthenticated: true });
      request.mockRejectedValueOnce({ response: { errors: [{ extensions: { code: 'NOT_FOUND' } }] } });
      render(checkoutContent({ ...EMPTY_STATUS, hasSupported: true, showPublicly }));
      const visibility = screen.getByRole('checkbox', {
        name: tFromCatalog('marketing', 'support.manage.publicCredit'),
      }) as HTMLInputElement;
      fireEvent.click(visibility);
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain(tFromCatalog('marketing', 'support.stripe.error')),
      );
      expect(visibility.checked).toBe(showPublicly);
      expect(visibility.disabled).toBe(false);
      expect(
        (
          screen.getByRole('checkbox', {
            name: tFromCatalog('marketing', 'support.stripe.publicCredit'),
          }) as HTMLInputElement
        ).checked,
      ).toBe(showPublicly);
      request.mockResolvedValueOnce({
        updateSupporterVisibility: { ...EMPTY_STATUS, hasSupported: true, showPublicly: !showPublicly },
      });
      fireEvent.click(visibility);
      await waitFor(() => expect(visibility.checked).toBe(!showPublicly));
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['checkout', 'portal'])(
    'releases busy after successful %s navigation returns without leaving the page',
    async (flow) => {
      Object.assign(authState, { token: 'account-token', isAuthenticated: true });
      let finishRequest: (response: unknown) => void = () => {};
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRequest = resolve;
          }),
      );
      render(
        checkoutContent({ ...EMPTY_STATUS, hasSupported: flow === 'portal', hasActiveSubscription: flow === 'portal' }),
      );
      const buttonName = tFromCatalog('marketing', flow === 'portal' ? 'support.manage.billing' : 'support.stripe.cta');
      const button = screen.getAllByRole('button', { name: buttonName })[0];
      fireEvent.click(button);
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
      expect(request).toHaveBeenCalledTimes(1);
      // A same-document destination makes jsdom's assign return without unloading,
      // matching a browser that keeps this page open after a navigation attempt.
      const url = `${window.location.href.split('#')[0]}#${flow}`;
      await act(async () =>
        finishRequest(
          flow === 'portal'
            ? { createSupportBillingPortalSession: { url } }
            : { createSupportCheckoutSession: { url } },
        ),
      );
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
      request.mockRejectedValueOnce(new Error('Retry request'));
      fireEvent.click(button);
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    },
  );

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
